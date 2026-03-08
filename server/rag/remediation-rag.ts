import { loadTemplatesFromDirectory, type RemediationTemplate } from './template-loader';
import { generateEmbedding, queryVectorStore, addToVectorStore, initializeVectorStore } from './vector-store';
import { calculateConfidence } from './confidence-scorer';
import { fixSnippetStore, type FixSnippet, type FixSnippetResult, type IaCFramework } from './fix-snippet-store';
import { performanceLogger } from '../utils/performance-logger';
import { featureFlags } from '../middleware/feature-flags';
import { checkovFetcher } from './checkov-fetcher';

export interface RemediationResult {
  template?: RemediationTemplate; // Keep for backward compatibility
  snippet?: FixSnippet; // New: fix snippet
  confidence: number;
  matchReason: string;
  similarityScore?: number;
  source?: 'retrieved' | 'generated';
}

export interface RemediationDecision {
  apply: boolean;
  requiresReview: boolean;
  confidence: number;
  reason: string;
}

export class RemediationRAGService {
  private initialized = false;
  private templates: RemediationTemplate[] = []; // Keep for backward compatibility

  /**
   * Initialize the RAG service by loading fix snippets and indexing them
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize embedding cache (load from disk)
    const { embeddingCache } = await import('./embedding-cache');
    await embeddingCache.loadFromDisk();

    // Initialize vector store
    initializeVectorStore();

    // Load fix snippets from store
    await fixSnippetStore.loadFromDisk();
    const snippetStats = fixSnippetStore.getStats();

    // Conditional template loading — skip once verified fixes reach threshold
    const deprecationThreshold = parseInt(process.env.TEMPLATE_DEPRECATION_THRESHOLD || '50', 10);
    const verifiedCount = fixSnippetStore.getVerifiedCount();

    if (verifiedCount < deprecationThreshold) {
      this.templates = await loadTemplatesFromDirectory();
    }

    // Index fix snippets and templates in vector database
    await this.indexFixSnippets();
    if (this.templates.length > 0) {
      await this.indexTemplates();
    }

    this.initialized = true;
    const usingFallback = embeddingCache.getStats().bySource?.fallback > 0;
    console.log(
      `✅ RAG initialized — ${snippetStats.active} snippets, ${this.templates.length} templates` +
      (usingFallback ? ' (fallback embeddings — add OpenAI credits for semantic search)' : '')
    );
  }

  /**
   * Index all templates in the vector database
   * Now uses caching to avoid redundant API calls
   */
  private async indexTemplates(): Promise<void> {
    for (const template of this.templates) {
      try {
        const embeddingText = this.createEmbeddingText(template);
        const embedding = await generateEmbedding(embeddingText);

        await addToVectorStore({
          id: template.check_id,
          embedding,
          metadata: {
            template,
            check_id: template.check_id,
            check_name: template.check_name,
            resource_types: template.resource_types,
            tags: template.tags,
            keywords: template.keywords,
          },
        });
      } catch (error: any) {
        console.error(`❌ Failed to index template ${template.check_id}:`, error.message);
      }
    }
  }

  /**
   * Create text for embedding from template
   */
  private createEmbeddingText(template: RemediationTemplate): string {
    return `
      Check ID: ${template.check_id}
      Check Name: ${template.check_name}
      Resource Types: ${template.resource_types.join(', ')}
      Description: ${template.description}
      Terraform Attribute: ${template.terraform_attribute}
      Attribute Type: ${template.attribute_type}
      Tags: ${template.tags.join(', ')}
      Keywords: ${template.keywords.join(', ')}
      Remediation: ${template.remediation_snippet}
      Example: ${template.complete_example}
    `.trim();
  }

  /**
   * Find remediation fix snippet for a check
   * Now uses fix snippets instead of templates
   * @param checkId - Checkov check ID
   * @param checkName - Human-readable check name
   * @param guideline - Checkov guideline URL or description
   * @param resourceType - Resource type (Terraform resource or K8s kind)
   * @param framework - IaC framework: 'terraform' or 'kubernetes'
   */
  async findRemediation(
    checkId: string,
    checkName: string,
    guideline: string,
    resourceType: string,
    framework: IaCFramework = 'terraform'
  ): Promise<RemediationResult | null> {
    // Track performance
    const perfId = performanceLogger.start('findRemediation', {
      checkId,
      resourceType,
      framework,
    });

    try {
      // Ensure service is initialized
      if (!this.initialized) {
        await this.initialize();
      }

      // Tier 1: Exact match in fix snippet store (fast lookup, framework-aware)
      const exactMatchPerfId = performanceLogger.start('findRemediation.exactMatch');
      const exactMatch = await fixSnippetStore.getByKey(checkId, resourceType, framework);
      performanceLogger.end(exactMatchPerfId, !!exactMatch);

      if (exactMatch && !exactMatch.deprecated && exactMatch.confidence >= 0.7) {
        console.log(`✅ Exact match found for ${checkId} in fix snippet store`);
        performanceLogger.end(perfId, true);
        return {
          snippet: exactMatch,
          confidence: exactMatch.confidence,
          matchReason: 'Exact match from fix snippet store',
          source: 'retrieved',
        };
      }

      // Tier 2: Semantic search in vector DB — return best match if confidence >= 0.7
      const semanticPerfId = performanceLogger.start('findRemediation.semanticSearch');
      const queryText = `${checkId} ${checkName} ${guideline} ${resourceType}`;
      const results = await queryVectorStore({
        query: queryText,
        topK: 5,
      });
      performanceLogger.end(semanticPerfId, true);

      if (results.length > 0) {
        const validResults = results
          .map(r => {
            const snippet = r.metadata.snippet as FixSnippet | undefined;
            const template = r.metadata.template as RemediationTemplate | undefined;

            // Filter by framework - only return snippets matching the requested framework
            if (snippet && !snippet.deprecated && snippet.confidence >= 0.6) {
              // Skip snippets from different frameworks
              const snippetFramework = snippet.framework || 'terraform';
              if (snippetFramework !== framework) {
                return null;
              }

              const baseConfidence = snippet.confidence;
              const similarityBoost = r.score * 0.2;
              const successBoost = Math.min(0.1, snippet.successCount * 0.01);
              const confidence = Math.min(1.0, baseConfidence + similarityBoost + successBoost);

              return {
                snippet,
                confidence,
                score: r.score,
                type: 'snippet' as const,
              };
            } else if (template && framework === 'terraform') {
              // Templates are only for Terraform (backward compatibility)
              const confidence = calculateConfidence(checkId, template, r.score);
              return {
                template,
                confidence,
                score: r.score,
                type: 'template' as const,
              };
            }
            return null;
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .sort((a, b) => {
            if (a.type === 'snippet' && b.type === 'template') return -1;
            if (a.type === 'template' && b.type === 'snippet') return 1;
            return b.confidence - a.confidence;
          });

        if (validResults.length > 0 && validResults[0].confidence >= 0.7) {
          const best = validResults[0];
          const matchReason = best.type === 'snippet'
            ? `Fix snippet match (confidence: ${(best.confidence * 100).toFixed(1)}%)`
            : `Template match (backward compatibility)`;

          console.log(`🔍 Found remediation for ${checkId}:`);
          if (best.type === 'snippet') {
            console.log(`   Snippet: ${best.snippet.checkId} → ${best.snippet.resourceType}`);
            console.log(`   Confidence: ${(best.confidence * 100).toFixed(1)}%`);
            console.log(`   Source: ${best.snippet.source}`);
          } else {
            console.log(`   Template: ${best.template.check_id}`);
            console.log(`   Confidence: ${(best.confidence * 100).toFixed(1)}%`);
          }
          console.log(`   Reason: ${matchReason}`);

          performanceLogger.end(perfId, true);
          return {
            snippet: best.type === 'snippet' ? best.snippet : undefined,
            template: best.type === 'template' ? best.template : undefined,
            confidence: best.confidence,
            matchReason,
            similarityScore: best.score,
            source: 'retrieved',
          };
        }
      }

      // Tier 3: Template fallback (backward compatibility)
      const templateMatch = this.templates.find(t => t.check_id === checkId);
      if (templateMatch) {
        console.log(`✅ Found template match for ${checkId} (backward compatibility)`);
        performanceLogger.end(perfId, true);
        return {
          template: templateMatch,
          confidence: 1.0,
          matchReason: 'Exact template match (backward compatibility)',
          similarityScore: 1.0,
          source: 'retrieved',
        };
      }

      // Tier 4: Checkov native fetch (feature-flag guarded, framework-aware)
      if (featureFlags.checkovNativeFetch) {
        const checkovPerfId = performanceLogger.start('findRemediation.checkovFetch', { checkId, resourceType, framework });
        try {
          // Pass framework to Checkov fetcher for appropriate path selection
          const inferred = await checkovFetcher.fetchRemediation(checkId, resourceType, framework);
          if (inferred) {
            // Determine cloud provider based on framework
            const cloudProvider = framework === 'kubernetes' ? 'kubernetes' : 'azure';
            const storedSnippet = await fixSnippetStore.store({
              checkId,
              resourceType,
              cloudProvider,
              framework,
              fixSnippet: inferred.fixSnippet,
              context: `Inferred from Checkov: ${inferred.attributeName} = ${JSON.stringify(inferred.expectedValue)}`,
              guideline,
              source: 'retrieved',
              confidence: inferred.confidence,
              successCount: 0,
              failureCount: 0,
              verified: false,
              deprecated: false,
              lastUsed: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            performanceLogger.end(checkovPerfId, true);
            console.log(`✅ Checkov native fetch succeeded for ${checkId} (${framework})`);
            performanceLogger.end(perfId, true);
            return {
              snippet: storedSnippet,
              confidence: inferred.confidence,
              matchReason: `Checkov native remediation (inferred from ${framework} source)`,
              source: 'retrieved',
            };
          }
          performanceLogger.end(checkovPerfId, false, 'No remediation inferred');
        } catch (error: any) {
          console.warn(`⚠️  Checkov fetch failed for ${checkId}: ${error.message}`);
          performanceLogger.end(checkovPerfId, false, error.message);
        }
      }

      // Tier 5: No match found — caller triggers AI generation + auto-storage via storeGeneratedFix()
      console.log(`⚠️  No remediation found for ${checkId}`);
      performanceLogger.end(perfId, false, 'No suitable match found');
      return null;
    } catch (error) {
      performanceLogger.end(perfId, false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Get human-readable match reason
   */
  private getMatchReason(
    checkId: string,
    template: RemediationTemplate,
    similarityScore: number
  ): string {
    if (template.check_id === checkId) {
      return 'Exact check ID match';
    }
    if (similarityScore >= 0.9) {
      return 'Very high similarity';
    }
    if (similarityScore >= 0.7) {
      return 'High similarity';
    }
    if (similarityScore >= 0.5) {
      return 'Moderate similarity';
    }
    return 'Low similarity - may not be accurate';
  }

  /**
   * Determine if fix should be applied based on confidence
   */
  shouldApplyFix(confidence: number): RemediationDecision {
    if (confidence >= 0.8) {
      return {
        apply: true,
        requiresReview: false,
        confidence,
        reason: 'High confidence - safe to apply automatically',
      };
    } else if (confidence >= 0.6) {
      return {
        apply: true,
        requiresReview: true,
        confidence,
        reason: 'Medium confidence - apply with warning, review recommended',
      };
    } else {
      return {
        apply: false,
        requiresReview: true,
        confidence,
        reason: 'Low confidence - manual review required before applying',
      };
    }
  }

  /**
   * Get template by check ID (exact match, no RAG)
   * Kept for backward compatibility
   */
  getTemplateByCheckId(checkId: string): RemediationTemplate | null {
    return this.templates.find(t => t.check_id === checkId) || null;
  }

  /**
   * Index fix snippets in vector database
   */
  private async indexFixSnippets(): Promise<void> {
    const snippets = await fixSnippetStore.getActive();
    
    if (snippets.length === 0) {
      return;
    }

    const { embeddingCache } = await import('./embedding-cache');

    for (const snippet of snippets) {
      try {
        const embeddingText = this.createEmbeddingTextFromSnippet(snippet);
        const embedding = await generateEmbedding(embeddingText);

        await addToVectorStore({
          id: snippet.id,
          embedding,
          metadata: {
            snippet,
            checkId: snippet.checkId,
            resourceType: snippet.resourceType,
            cloudProvider: snippet.cloudProvider,
            confidence: snippet.confidence,
            successCount: snippet.successCount,
            source: snippet.source,
          },
        });
      } catch (error: any) {
        console.error(`❌ Failed to index fix snippet ${snippet.id}:`, error.message);
      }
    }
  }

  /**
   * Create embedding text from fix snippet
   */
  private createEmbeddingTextFromSnippet(snippet: FixSnippet): string {
    return `
      Check ID: ${snippet.checkId}
      Resource Type: ${snippet.resourceType}
      Cloud Provider: ${snippet.cloudProvider}
      Framework: ${snippet.framework || 'terraform'}
      Guideline: ${snippet.guideline}
      Fix Snippet: ${snippet.fixSnippet}
      Context: ${snippet.context}
    `.trim();
  }

  /**
   * Store a generated fix snippet in the database
   * @param framework - IaC framework: 'terraform' or 'kubernetes'
   */
  async storeGeneratedFix(
    checkId: string,
    resourceType: string,
    cloudProvider: string,
    fixSnippet: string,
    context: string,
    guideline: string,
    framework: IaCFramework = 'terraform'
  ): Promise<FixSnippet> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check if already exists (framework-aware)
    const existing = await fixSnippetStore.getByKey(checkId, resourceType, framework);
    if (existing) {
      console.log(`⚠️  Fix snippet already exists for ${checkId}:${resourceType}:${framework}, skipping store`);
      return existing;
    }

    // Create new snippet
    const snippet = await fixSnippetStore.store({
      checkId,
      resourceType,
      cloudProvider,
      framework,
      fixSnippet,
      context,
      guideline,
      source: 'generated',
      confidence: 0.6, // Low initial confidence
      successCount: 0,
      failureCount: 0,
      verified: false,
      deprecated: false,
      lastUsed: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Index in vector DB
    await this.indexFixSnippet(snippet);

    console.log(`💾 Stored generated fix snippet: ${checkId} → ${resourceType} (${framework}, confidence: 0.6)`);

    return snippet;
  }

  /**
   * Index a single fix snippet in vector DB
   */
  private async indexFixSnippet(snippet: FixSnippet): Promise<void> {
    try {
      const embeddingText = this.createEmbeddingTextFromSnippet(snippet);
      const embedding = await generateEmbedding(embeddingText);

      await addToVectorStore({
        id: snippet.id,
        embedding,
        metadata: {
          snippet,
          checkId: snippet.checkId,
          resourceType: snippet.resourceType,
          cloudProvider: snippet.cloudProvider,
          framework: snippet.framework || 'terraform',
          confidence: snippet.confidence,
          successCount: snippet.successCount,
          source: snippet.source,
        },
      });
    } catch (error: any) {
      console.error(`❌ Failed to index fix snippet ${snippet.id}:`, error.message);
    }
  }

  /**
   * Update fix snippet confidence based on verification result
   */
  async updateFixFromVerification(
    snippetId: string,
    passed: boolean
  ): Promise<void> {
    const snippet = await fixSnippetStore.get(snippetId);
    if (!snippet) {
      console.warn(`⚠️  Fix snippet not found: ${snippetId}`);
      return;
    }

    if (passed) {
      snippet.successCount++;
      snippet.confidence = Math.min(1.0, snippet.confidence + 0.2);
      snippet.verified = true;
      console.log(`✅ Updated fix snippet ${snippetId}: confidence → ${snippet.confidence.toFixed(2)} (success)`);
    } else {
      snippet.failureCount++;
      snippet.confidence = Math.max(0.0, snippet.confidence - 0.3);
      
      if (snippet.confidence < 0.5) {
        snippet.deprecated = true;
        console.log(`⚠️  Deprecated fix snippet ${snippetId}: confidence → ${snippet.confidence.toFixed(2)} (too low)`);
      } else {
        console.log(`⚠️  Updated fix snippet ${snippetId}: confidence → ${snippet.confidence.toFixed(2)} (failure)`);
      }
    }

    snippet.lastUsed = new Date();
    snippet.updatedAt = new Date();

    await fixSnippetStore.update(snippetId, snippet);

    // Re-index if confidence changed significantly
    if (Math.abs(snippet.confidence - (await fixSnippetStore.get(snippetId))?.confidence || 0) > 0.1) {
      // Remove old index and re-index
      // Note: This is simplified - in production, you'd want to update the vector DB entry
      if (!snippet.deprecated) {
        await this.indexFixSnippet(snippet);
      }
    }
  }
}

// Singleton instance
export const remediationRAGService = new RemediationRAGService();

