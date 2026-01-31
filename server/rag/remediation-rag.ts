import { loadTemplatesFromDirectory, type RemediationTemplate } from './template-loader';
import { generateEmbedding, queryVectorStore, addToVectorStore, initializeVectorStore } from './vector-store';
import { calculateConfidence } from './confidence-scorer';
import { fixSnippetStore, type FixSnippet, type FixSnippetResult } from './fix-snippet-store';

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

    console.log('🔍 Initializing Remediation RAG Service...');

    // Initialize embedding cache (load from disk)
    const { embeddingCache } = await import('./embedding-cache');
    await embeddingCache.loadFromDisk();
    const cacheStats = embeddingCache.getStats();
    if (cacheStats.total > 0) {
      console.log(`💾 Embedding cache: ${cacheStats.total} cached embedding(s) loaded`);
      console.log(`   Sources: ${JSON.stringify(cacheStats.bySource)}`);
    }

    // Initialize vector store
    initializeVectorStore();

    // Load fix snippets from store
    await fixSnippetStore.loadFromDisk();
    const snippetStats = fixSnippetStore.getStats();
    console.log(`📚 Loaded ${snippetStats.total} fix snippet(s)`);
    console.log(`   Active: ${snippetStats.active}, Deprecated: ${snippetStats.deprecated}`);
    console.log(`   By Source: ${JSON.stringify(snippetStats.bySource)}`);

    // Also load templates for backward compatibility
    this.templates = await loadTemplatesFromDirectory();
    if (this.templates.length > 0) {
      console.log(`📚 Also loaded ${this.templates.length} template(s) for backward compatibility`);
    }

    // Index fix snippets in vector database
    await this.indexFixSnippets();

    // Also index templates for backward compatibility
    if (this.templates.length > 0) {
      await this.indexTemplates();
    }

    this.initialized = true;
    console.log('✅ Remediation RAG Service initialized');
  }

  /**
   * Index all templates in the vector database
   * Now uses caching to avoid redundant API calls
   */
  private async indexTemplates(): Promise<void> {
    console.log('📇 Indexing templates in vector database...');

    const { embeddingCache } = await import('./embedding-cache');
    const initialCacheSize = embeddingCache.getStats().total;
    
    let indexed = 0;
    let cachedCount = 0;
    let newOpenaiCount = 0;
    let fallbackCount = 0;
    
    for (const template of this.templates) {
      try {
        // Create embedding text from template
        const embeddingText = this.createEmbeddingText(template);

        // Check if already cached before generating
        const cacheKey = embeddingCache.generateHash(embeddingText, 'text-embedding-3-small');
        const wasCached = await embeddingCache.get(cacheKey) !== null;
        
        if (wasCached) {
          cachedCount++;
        }

        // Generate embedding (will use cache if available)
        const embedding = await generateEmbedding(embeddingText);
        
        // Check if we're using fallback (simple heuristic: check if embedding values are very small)
        // Fallback embeddings have values around 0.1, OpenAI embeddings are typically larger
        const isFallback = Math.max(...embedding.map(Math.abs)) < 0.5;
        if (isFallback) {
          fallbackCount++;
        } else if (!wasCached) {
          // New OpenAI embedding (not from cache)
          newOpenaiCount++;
        }

        // Store in vector database
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

        indexed++;
      } catch (error: any) {
        console.error(`❌ Failed to index template ${template.check_id}:`, error.message);
      }
    }

    // Get final cache stats
    const finalStats = embeddingCache.getStats();
    const newCacheEntries = finalStats.total - initialCacheSize;

    // Log results
    if (cachedCount > 0) {
      console.log(`✅ Indexed ${indexed}/${this.templates.length} template(s)`);
      console.log(`   💾 Cache hits: ${cachedCount} (saved ${cachedCount} API calls!)`);
      if (newOpenaiCount > 0) {
        console.log(`   🆕 New OpenAI calls: ${newOpenaiCount}`);
      }
      if (newCacheEntries > 0) {
        console.log(`   💾 Cached ${newCacheEntries} new embedding(s) for future use`);
      }
    } else {
      console.log(`✅ Indexed ${indexed}/${this.templates.length} template(s)`);
      if (newOpenaiCount > 0) {
        console.log(`   🆕 Generated ${newOpenaiCount} new OpenAI embedding(s)`);
      }
      if (newCacheEntries > 0) {
        console.log(`   💾 Cached ${newCacheEntries} embedding(s) for future use`);
      }
    }

    if (fallbackCount > 0) {
      console.log(`   ⚠️  ${fallbackCount} template(s) using fallback embeddings (OpenAI quota exceeded)`);
      console.log('   💡 To use OpenAI embeddings: Add credits at https://platform.openai.com/account/billing');
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
   */
  async findRemediation(
    checkId: string,
    checkName: string,
    guideline: string,
    resourceType: string
  ): Promise<RemediationResult | null> {
    // Ensure service is initialized
    if (!this.initialized) {
      await this.initialize();
    }

    // 1. Try exact match in fix snippet store first (fast lookup)
    const exactMatch = await fixSnippetStore.getByKey(checkId, resourceType);
    if (exactMatch && !exactMatch.deprecated && exactMatch.confidence >= 0.7) {
      console.log(`✅ Exact match found for ${checkId} in fix snippet store`);
      return {
        snippet: exactMatch,
        confidence: exactMatch.confidence,
        matchReason: 'Exact match from fix snippet store',
        source: 'retrieved',
      };
    }

    // 2. Semantic search in vector DB
    const queryText = `${checkId} ${checkName} ${guideline} ${resourceType}`;
    const results = await queryVectorStore({
      query: queryText,
      topK: 5,
    });

    if (results.length === 0) {
      // 3. Fallback to template search for backward compatibility
      const templateMatch = this.templates.find(t => t.check_id === checkId);
      if (templateMatch) {
        console.log(`✅ Found template match for ${checkId} (backward compatibility)`);
        return {
          template: templateMatch,
          confidence: 1.0,
          matchReason: 'Exact template match (backward compatibility)',
          similarityScore: 1.0,
          source: 'retrieved',
        };
      }

      console.log(`⚠️  No remediation found for ${checkId}`);
      return null;
    }

    // 4. Filter and score results (prioritize fix snippets over templates)
    const validResults = results
      .map(r => {
        // Check if it's a fix snippet or template
        const snippet = r.metadata.snippet as FixSnippet | undefined;
        const template = r.metadata.template as RemediationTemplate | undefined;

        if (snippet && !snippet.deprecated && snippet.confidence >= 0.6) {
          // Calculate confidence based on similarity and success count
          const baseConfidence = snippet.confidence;
          const similarityBoost = r.score * 0.2; // Boost from similarity
          const successBoost = Math.min(0.1, snippet.successCount * 0.01); // Small boost per success
          const confidence = Math.min(1.0, baseConfidence + similarityBoost + successBoost);

          return {
            snippet,
            confidence,
            score: r.score,
            type: 'snippet' as const,
          };
        } else if (template) {
          // Backward compatibility: use template
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
        // Prioritize snippets over templates, then by confidence
        if (a.type === 'snippet' && b.type === 'template') return -1;
        if (a.type === 'template' && b.type === 'snippet') return 1;
        return b.confidence - a.confidence;
      });

    // 5. Return best match if confidence >= 0.7
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

      return {
        snippet: best.type === 'snippet' ? best.snippet : undefined,
        template: best.type === 'template' ? best.template : undefined,
        confidence: best.confidence,
        matchReason,
        similarityScore: best.score,
        source: 'retrieved',
      };
    }

    // 6. No good match - will generate
    console.log(`⚠️  No suitable remediation found for ${checkId} (confidence < 0.7)`);
    return null;
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
      console.log('📇 No fix snippets to index');
      return;
    }

    console.log(`📇 Indexing ${snippets.length} fix snippet(s) in vector database...`);

    const { embeddingCache } = await import('./embedding-cache');
    let indexed = 0;
    let cachedCount = 0;
    let newOpenaiCount = 0;
    let fallbackCount = 0;

    for (const snippet of snippets) {
      try {
        // Create embedding text from snippet
        const embeddingText = this.createEmbeddingTextFromSnippet(snippet);

        // Check if already cached
        const cacheKey = embeddingCache.generateHash(embeddingText, 'text-embedding-3-small');
        const wasCached = await embeddingCache.get(cacheKey) !== null;
        
        if (wasCached) {
          cachedCount++;
        }

        // Generate embedding (will use cache if available)
        const embedding = await generateEmbedding(embeddingText);
        
        // Check if using fallback
        const isFallback = Math.max(...embedding.map(Math.abs)) < 0.5;
        if (isFallback) {
          fallbackCount++;
        } else if (!wasCached) {
          newOpenaiCount++;
        }

        // Store in vector database
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

        indexed++;
      } catch (error: any) {
        console.error(`❌ Failed to index fix snippet ${snippet.id}:`, error.message);
      }
    }

    console.log(`✅ Indexed ${indexed}/${snippets.length} fix snippet(s)`);
    if (cachedCount > 0) {
      console.log(`   💾 Cache hits: ${cachedCount}`);
    }
    if (newOpenaiCount > 0) {
      console.log(`   🆕 New OpenAI calls: ${newOpenaiCount}`);
    }
    if (fallbackCount > 0) {
      console.log(`   ⚠️  ${fallbackCount} snippet(s) using fallback embeddings`);
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
      Guideline: ${snippet.guideline}
      Fix Snippet: ${snippet.fixSnippet}
      Context: ${snippet.context}
    `.trim();
  }

  /**
   * Store a generated fix snippet in the database
   */
  async storeGeneratedFix(
    checkId: string,
    resourceType: string,
    cloudProvider: string,
    fixSnippet: string,
    context: string,
    guideline: string
  ): Promise<FixSnippet> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check if already exists
    const existing = await fixSnippetStore.getByKey(checkId, resourceType);
    if (existing) {
      console.log(`⚠️  Fix snippet already exists for ${checkId}:${resourceType}, skipping store`);
      return existing;
    }

    // Create new snippet
    const snippet = await fixSnippetStore.store({
      checkId,
      resourceType,
      cloudProvider,
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

    console.log(`💾 Stored generated fix snippet: ${checkId} → ${resourceType} (confidence: 0.6)`);

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

