/**
 * Intelligent Fix Retriever
 *
 * Phase 4: Unified orchestrator that integrates all fix sources into a single
 * retrieval interface. Adds two user-aware tiers on top of the existing RAG waterfall:
 *
 *   Tier 1 — User preferences   (authenticated, ENABLE_USER_FIX_PREFERENCES)
 *   Tier 2 — Checkov native     (ENABLE_CHECKOV_NATIVE_FETCH, auto-stores on hit)
 *   Tier 3-5 — RAG waterfall    (delegates to remediationRAGService.findRemediation)
 *
 * Each tier degrades gracefully — failures return null, never throw.
 * Feature flags control each tier independently for gradual rollout.
 *
 * Extended to support Kubernetes framework alongside Terraform.
 */

import { remediationRAGService } from './remediation-rag';
import { userFixPreferencesStore } from './user-fix-preferences-store';
import { checkovFetcher } from './checkov-fetcher';
import { fixSnippetStore, type IaCFramework } from './fix-snippet-store';
import { featureFlags } from '../middleware/feature-flags';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface IntelligentFixResult {
  fix: string;
  confidence: number;
  source: 'user_preference' | 'checkov_official' | 'global_cache' | 'semantic_match' | 'ai_generated';
  requiresReview: boolean;
  metadata?: {
    timesUsed?: number;
    successRate?: number;
    guidelineUrl?: string;
  };
}

export class IntelligentFixRetriever {
  /**
   * Unified intelligent fix retrieval.
   * Tiers 1-2 are resolved here; Tiers 3-5 delegate to the existing RAG waterfall.
   * @param framework - IaC framework: 'terraform' or 'kubernetes'
   */
  async getFixForCheck(
    checkId: string,
    resourceType: string,
    checkName: string,
    guideline: string,
    userId?: string,
    context?: string,
    cloudProvider?: string,
    framework: IaCFramework = 'terraform'
  ): Promise<IntelligentFixResult | null> {
    console.log(`🔍 Intelligent fix retrieval for ${checkId} (user: ${userId || 'anonymous'}, provider: ${cloudProvider || 'unknown'}, framework: ${framework})`);

    // TIER 1: User-specific preferences (authenticated users only)
    if (userId && featureFlags.userFixPreferences) {
      const userFix = await this.getTier1UserPreference(userId, checkId, resourceType, framework);
      if (userFix) return userFix;
    }

    // TIER 2: Checkov native remediation (framework-aware)
    if (featureFlags.checkovNativeFetch) {
      const checkovFix = await this.getTier2CheckovNative(checkId, resourceType, guideline, cloudProvider, framework);
      if (checkovFix) return checkovFix;
    }

    // TIER 3-5: Existing RAG system (global cache → semantic → template → Checkov fetch → AI)
    const ragResult = await this.getTier3to5ExistingRAG(checkId, checkName, guideline, resourceType, framework);
    if (ragResult) return ragResult;

    // TIER 6: AI generation fallback (framework-aware)
    if (featureFlags.kubernetesAIGeneration || framework === 'terraform') {
      const aiResult = await this.generateFixWithAI(checkId, checkName, resourceType, guideline, context, framework);
      if (aiResult) return aiResult;
    }

    console.log(`❌ No fix found for ${checkId}`);
    return null;
  }

  /**
   * TIER 1: User-specific preferences — fastest path for returning users.
   * Only runs when the user is authenticated and ENABLE_USER_FIX_PREFERENCES is on.
   * Calls incrementUsage on hit so confidence self-adjusts over time.
   */
  private async getTier1UserPreference(
    userId: string,
    checkId: string,
    resourceType: string,
    framework: IaCFramework = 'terraform'
  ): Promise<IntelligentFixResult | null> {
    try {
      // User preferences are keyed by checkId + resourceType (framework handled via resourceType uniqueness)
      const pref = await userFixPreferencesStore.getUserPreference(userId, checkId, resourceType);

      if (pref && pref.confidence >= 0.7) {
        console.log(`✅ [TIER 1] User preference hit for ${checkId} (confidence: ${pref.confidence}, framework: ${framework})`);

        // Increment usage — also adjusts confidence (+0.05 on this success path)
        await userFixPreferencesStore.incrementUsage(pref.id, true);

        return {
          fix: pref.fixSnippet,
          confidence: pref.confidence,
          source: 'user_preference',
          requiresReview: false,
          metadata: {
            timesUsed: pref.timesUsed + 1,
            successRate: pref.successCount / Math.max(1, pref.successCount + pref.failureCount),
          },
        };
      }

      console.log(`⏭️  [TIER 1] No user preference found`);
      return null;
    } catch (error: any) {
      console.warn(`⚠️  [TIER 1] User preference lookup failed: ${error.message}`);
      return null;
    }
  }

  /**
   * TIER 2: Checkov native remediation — infers fix from Checkov Python source on GitHub.
   * Auto-stores successful results in the global fix snippet store so they are
   * findable at Tier 3 (exact match) on the next request without another GitHub call.
   */
  private async getTier2CheckovNative(
    checkId: string,
    resourceType: string,
    guideline: string,
    cloudProvider?: string,
    framework: IaCFramework = 'terraform'
  ): Promise<IntelligentFixResult | null> {
    try {
      // Pass framework to Checkov fetcher for appropriate path and inference logic
      const inferred = await checkovFetcher.fetchRemediation(checkId, resourceType, framework);

      if (inferred && inferred.fixSnippet) {
        console.log(`✅ [TIER 2] Checkov native remediation found (confidence: ${inferred.confidence}, framework: ${framework})`);

        // Auto-store in global cache for future hits (framework-aware)
        await this.storeInGlobalCache(checkId, resourceType, inferred.fixSnippet, guideline, inferred.confidence, cloudProvider, framework);

        return {
          fix: inferred.fixSnippet,
          confidence: inferred.confidence,
          source: 'checkov_official',
          requiresReview: inferred.confidence < 0.75,
          metadata: {
            guidelineUrl: guideline || undefined,
          },
        };
      }

      console.log(`⏭️  [TIER 2] No Checkov remediation found`);
      return null;
    } catch (error: any) {
      console.warn(`⚠️  [TIER 2] Checkov fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * TIER 3-5: Delegates to the existing RAG waterfall.
   * Internally runs: exact match → semantic search → template → Checkov fetch → null.
   * Maps the RAG result's source field to the unified IntelligentFixResult source label.
   */
  private async getTier3to5ExistingRAG(
    checkId: string,
    checkName: string,
    guideline: string,
    resourceType: string,
    framework: IaCFramework = 'terraform'
  ): Promise<IntelligentFixResult | null> {
    try {
      // Pass framework to RAG service for framework-aware retrieval
      const ragResult = await remediationRAGService.findRemediation(
        checkId,
        checkName,
        guideline,
        resourceType,
        framework
      );

      if (!ragResult) {
        console.log(`⏭️  [TIER 3-5] No RAG result found`);
        return null;
      }

      // Map RAG source to unified source label
      let source: IntelligentFixResult['source'];
      if (ragResult.snippet) {
        source = ragResult.snippet.source === 'retrieved' ? 'global_cache'
               : ragResult.snippet.source === 'generated' ? 'ai_generated'
               : 'semantic_match';
      } else {
        source = 'semantic_match';
      }

      const fix = ragResult.snippet?.fixSnippet || ragResult.template?.remediation_snippet || '';
      console.log(`✅ [TIER 3-5] RAG result found (source: ${source}, confidence: ${ragResult.confidence}, framework: ${framework})`);

      return {
        fix,
        confidence: ragResult.confidence,
        source,
        requiresReview: ragResult.confidence < 0.8,
      };
    } catch (error: any) {
      console.warn(`⚠️  [TIER 3-5] RAG retrieval failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Store a fix in the global snippet cache via the RAG service.
   * Skips silently if a snippet for this check + resource already exists
   * (storeGeneratedFix handles the duplicate check internally).
   */
  private async storeInGlobalCache(
    checkId: string,
    resourceType: string,
    fixSnippet: string,
    guideline: string,
    confidence: number,
    cloudProvider?: string,
    framework: IaCFramework = 'terraform'
  ): Promise<void> {
    try {
      // Determine cloud provider based on framework if not specified
      const provider = cloudProvider || (framework === 'kubernetes' ? 'kubernetes' : 'azure');
      await remediationRAGService.storeGeneratedFix(
        checkId,
        resourceType,
        provider,
        fixSnippet,
        `Checkov inferred fix (confidence: ${confidence})`,
        guideline,
        framework
      );
      console.log(`💾 Stored fix in global cache: ${checkId} → ${resourceType} (${framework})`);
    } catch (error: any) {
      console.warn(`⚠️  Failed to store in global cache: ${error.message}`);
    }
  }

  /**
   * TIER 6: AI generation fallback — generates fix using AI when no cached fix exists.
   * Framework-aware: uses different prompts for Terraform (HCL) vs Kubernetes (YAML).
   */
  private async generateFixWithAI(
    checkId: string,
    checkName: string,
    resourceType: string,
    guideline: string,
    context?: string,
    framework: IaCFramework = 'terraform'
  ): Promise<IntelligentFixResult | null> {
    try {
      console.log(`🤖 [TIER 6] Generating ${framework} fix with AI for ${checkId}`);

      const systemPrompt = framework === 'kubernetes'
        ? this.getKubernetesSystemPrompt()
        : this.getTerraformSystemPrompt();

      const userPrompt = framework === 'kubernetes'
        ? this.getKubernetesUserPrompt(checkId, checkName, resourceType, guideline, context)
        : this.getTerraformUserPrompt(checkId, checkName, resourceType, guideline, context);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const response = completion.choices[0]?.message?.content || '';

      // Extract code block from response
      const codeMatch = framework === 'kubernetes'
        ? response.match(/```(?:yaml|yml)?\n([\s\S]*?)```/)
        : response.match(/```(?:hcl|terraform)?\n([\s\S]*?)```/);

      const fixSnippet = codeMatch ? codeMatch[1].trim() : response.trim();

      if (!fixSnippet) {
        console.log(`⏭️  [TIER 6] AI generation returned empty response`);
        return null;
      }

      // Store the generated fix for future use
      await this.storeInGlobalCache(
        checkId,
        resourceType,
        fixSnippet,
        guideline,
        0.6, // Initial confidence for AI-generated fixes
        framework === 'kubernetes' ? 'kubernetes' : 'azure',
        framework
      );

      console.log(`✅ [TIER 6] AI generated fix for ${checkId} (${framework})`);

      return {
        fix: fixSnippet,
        confidence: 0.6,
        source: 'ai_generated',
        requiresReview: true, // AI-generated fixes always need review
        metadata: {
          guidelineUrl: guideline || undefined,
        },
      };
    } catch (error: any) {
      console.warn(`⚠️  [TIER 6] AI generation failed: ${error.message}`);
      return null;
    }
  }

  /**
   * System prompt for Kubernetes YAML fix generation
   */
  private getKubernetesSystemPrompt(): string {
    return `You are a Kubernetes security expert. Your task is to generate YAML snippets that fix security issues in Kubernetes manifests.

Guidelines:
1. Generate ONLY the YAML snippet needed to fix the issue
2. Use proper YAML indentation (2 spaces)
3. Include only the relevant fields, not the entire manifest
4. Follow Kubernetes best practices
5. Be concise - no explanations, just the fix

Common security fixes include:
- securityContext (runAsNonRoot, allowPrivilegeEscalation, readOnlyRootFilesystem)
- resources (limits and requests for CPU/memory)
- probes (livenessProbe, readinessProbe)
- capabilities (drop ALL)
- serviceAccountToken (automountServiceAccountToken: false)`;
  }

  /**
   * System prompt for Terraform HCL fix generation
   */
  private getTerraformSystemPrompt(): string {
    return `You are a Terraform security expert. Your task is to generate HCL code snippets that fix security issues in Terraform configurations.

Guidelines:
1. Generate ONLY the HCL code needed to fix the issue
2. Use proper HCL syntax
3. Include only the relevant attributes, not the entire resource
4. Follow cloud provider best practices
5. Be concise - no explanations, just the fix`;
  }

  /**
   * User prompt for Kubernetes fix generation
   */
  private getKubernetesUserPrompt(
    checkId: string,
    checkName: string,
    resourceKind: string,
    guideline: string,
    context?: string
  ): string {
    let prompt = `Fix this Kubernetes security issue:

Check ID: ${checkId}
Check Name: ${checkName}
Resource Kind: ${resourceKind}
Guideline: ${guideline}`;

    if (context) {
      prompt += `\n\nCurrent YAML context:\n\`\`\`yaml\n${context}\n\`\`\``;
    }

    prompt += `\n\nGenerate the YAML snippet that fixes this issue:`;
    return prompt;
  }

  /**
   * User prompt for Terraform fix generation
   */
  private getTerraformUserPrompt(
    checkId: string,
    checkName: string,
    resourceType: string,
    guideline: string,
    context?: string
  ): string {
    let prompt = `Fix this Terraform security issue:

Check ID: ${checkId}
Check Name: ${checkName}
Resource Type: ${resourceType}
Guideline: ${guideline}`;

    if (context) {
      prompt += `\n\nCurrent Terraform context:\n\`\`\`hcl\n${context}\n\`\`\``;
    }

    prompt += `\n\nGenerate the HCL code that fixes this issue:`;
    return prompt;
  }

  /**
   * Store a verified fix — called after the user confirms a fix worked.
   * Updates both the global snippet store and (if enabled) the user's preference table.
   * If a global snippet already exists, bumps its confidence rather than re-storing.
   */
  async storeVerifiedFix(
    checkId: string,
    resourceType: string,
    fix: string,
    userId?: string,
    verified: boolean = true,
    cloudProvider?: string,
    framework: IaCFramework = 'terraform'
  ): Promise<void> {
    console.log(`💾 Storing verified fix for ${checkId} (verified: ${verified}, user: ${userId || 'anonymous'}, provider: ${cloudProvider || 'unknown'}, framework: ${framework})`);

    // Global cache: bump confidence on existing snippet, or create new one (framework-aware)
    const existingSnippet = await fixSnippetStore.getByKey(checkId, resourceType, framework);
    if (existingSnippet) {
      await remediationRAGService.updateFixFromVerification(existingSnippet.id, verified);
    } else {
      await this.storeInGlobalCache(checkId, resourceType, fix, '', verified ? 0.95 : 0.7, cloudProvider, framework);
    }

    // User preference: store when authenticated and feature enabled
    if (userId && featureFlags.userFixPreferences) {
      await userFixPreferencesStore.storePreference({
        userId,
        checkId,
        resourceType,
        fixSnippet: fix,
        confidence: verified ? 1.0 : 0.8,
        source: verified ? 'user_verified' : 'user_preference',
        timesUsed: 1,
        successCount: verified ? 1 : 0,
        failureCount: 0,
        lastUsedAt: new Date(),
      });
      console.log(`✅ Stored as user preference for ${userId}`);
    }
  }

  /**
   * Report a fix failure — decrements confidence in both user preference and global cache.
   * User preference confidence adjusts by −0.1 (via incrementUsage).
   * Global snippet confidence adjusts by −0.3 (via updateFixFromVerification); auto-deprecates below 0.5.
   */
  async reportFixFailure(
    checkId: string,
    resourceType: string,
    userId?: string,
    framework: IaCFramework = 'terraform'
  ): Promise<void> {
    console.log(`⚠️  Reporting fix failure for ${checkId} (framework: ${framework})`);

    // Decrement user preference confidence
    if (userId && featureFlags.userFixPreferences) {
      const pref = await userFixPreferencesStore.getUserPreference(userId, checkId, resourceType);
      if (pref) {
        await userFixPreferencesStore.incrementUsage(pref.id, false);
      }
    }

    // Decrement global cache confidence (framework-aware)
    const globalSnippet = await fixSnippetStore.getByKey(checkId, resourceType, framework);
    if (globalSnippet) {
      await remediationRAGService.updateFixFromVerification(globalSnippet.id, false);
    }
  }
}

// Singleton instance
export const intelligentFixRetriever = new IntelligentFixRetriever();
