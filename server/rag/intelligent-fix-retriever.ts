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
 */

import { remediationRAGService } from './remediation-rag';
import { userFixPreferencesStore } from './user-fix-preferences-store';
import { checkovFetcher } from './checkov-fetcher';
import { fixSnippetStore } from './fix-snippet-store';
import { featureFlags } from '../middleware/feature-flags';

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
   */
  async getFixForCheck(
    checkId: string,
    resourceType: string,
    checkName: string,
    guideline: string,
    userId?: string,
    context?: string,
    cloudProvider?: string
  ): Promise<IntelligentFixResult | null> {
    console.log(`🔍 Intelligent fix retrieval for ${checkId} (user: ${userId || 'anonymous'}, provider: ${cloudProvider || 'unknown'})`);

    // TIER 1: User-specific preferences (authenticated users only)
    if (userId && featureFlags.userFixPreferences) {
      const userFix = await this.getTier1UserPreference(userId, checkId, resourceType);
      if (userFix) return userFix;
    }

    // TIER 2: Checkov native remediation
    if (featureFlags.checkovNativeFetch) {
      const checkovFix = await this.getTier2CheckovNative(checkId, resourceType, guideline, cloudProvider);
      if (checkovFix) return checkovFix;
    }

    // TIER 3-5: Existing RAG system (global cache → semantic → template → Checkov fetch → AI)
    const ragResult = await this.getTier3to5ExistingRAG(checkId, checkName, guideline, resourceType);
    if (ragResult) return ragResult;

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
    resourceType: string
  ): Promise<IntelligentFixResult | null> {
    try {
      const pref = await userFixPreferencesStore.getUserPreference(userId, checkId, resourceType);

      if (pref && pref.confidence >= 0.7) {
        console.log(`✅ [TIER 1] User preference hit for ${checkId} (confidence: ${pref.confidence})`);

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
    cloudProvider?: string
  ): Promise<IntelligentFixResult | null> {
    try {
      const inferred = await checkovFetcher.fetchRemediation(checkId, resourceType);

      if (inferred && inferred.fixSnippet) {
        console.log(`✅ [TIER 2] Checkov native remediation found (confidence: ${inferred.confidence})`);

        // Auto-store in global cache for future hits
        await this.storeInGlobalCache(checkId, resourceType, inferred.fixSnippet, guideline, inferred.confidence, cloudProvider);

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
    resourceType: string
  ): Promise<IntelligentFixResult | null> {
    try {
      const ragResult = await remediationRAGService.findRemediation(
        checkId,
        checkName,
        guideline,
        resourceType
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
      console.log(`✅ [TIER 3-5] RAG result found (source: ${source}, confidence: ${ragResult.confidence})`);

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
    cloudProvider?: string
  ): Promise<void> {
    try {
      await remediationRAGService.storeGeneratedFix(
        checkId,
        resourceType,
        cloudProvider || 'azure',
        fixSnippet,
        `Checkov inferred fix (confidence: ${confidence})`,
        guideline
      );
      console.log(`💾 Stored fix in global cache: ${checkId} → ${resourceType}`);
    } catch (error: any) {
      console.warn(`⚠️  Failed to store in global cache: ${error.message}`);
    }
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
    cloudProvider?: string
  ): Promise<void> {
    console.log(`💾 Storing verified fix for ${checkId} (verified: ${verified}, user: ${userId || 'anonymous'}, provider: ${cloudProvider || 'unknown'})`);

    // Global cache: bump confidence on existing snippet, or create new one
    const existingSnippet = await fixSnippetStore.getByKey(checkId, resourceType);
    if (existingSnippet) {
      await remediationRAGService.updateFixFromVerification(existingSnippet.id, verified);
    } else {
      await this.storeInGlobalCache(checkId, resourceType, fix, '', verified ? 0.95 : 0.7, cloudProvider);
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
    userId?: string
  ): Promise<void> {
    console.log(`⚠️  Reporting fix failure for ${checkId}`);

    // Decrement user preference confidence
    if (userId && featureFlags.userFixPreferences) {
      const pref = await userFixPreferencesStore.getUserPreference(userId, checkId, resourceType);
      if (pref) {
        await userFixPreferencesStore.incrementUsage(pref.id, false);
      }
    }

    // Decrement global cache confidence
    const globalSnippet = await fixSnippetStore.getByKey(checkId, resourceType);
    if (globalSnippet) {
      await remediationRAGService.updateFixFromVerification(globalSnippet.id, false);
    }
  }
}

// Singleton instance
export const intelligentFixRetriever = new IntelligentFixRetriever();
