/**
 * Vector Store Wrapper for Checkov Remediation Templates
 *
 * This module provides a simple in-memory vector store implementation.
 * For production, consider using ChromaDB, Pinecone, or Qdrant.
 */

import { performanceLogger } from '../utils/performance-logger';

// Cost tracking
interface CostTracker {
  totalOpenAICalls: number;
  totalTokensUsed: number;
  estimatedCostUSD: number;
}

const costTracker: CostTracker = {
  totalOpenAICalls: 0,
  totalTokensUsed: 0,
  estimatedCostUSD: 0,
};

export function getCostStats(): CostTracker {
  return { ...costTracker };
}

interface VectorDocument {
  id: string;
  embedding: number[];
  metadata: any;
}

// Simple in-memory vector store (for now)
// TODO: Replace with ChromaDB or other vector database for production
class SimpleVectorStore {
  private documents: VectorDocument[] = [];
  private embeddings: Map<string, number[]> = new Map();

  async add(document: VectorDocument): Promise<void> {
    this.documents.push(document);
    this.embeddings.set(document.id, document.embedding);
  }

  async query(queryEmbedding: number[], topK: number = 5): Promise<Array<{ score: number; metadata: any }>> {
    const results: Array<{ score: number; metadata: any }> = [];

    for (const doc of this.documents) {
      const similarity = this.cosineSimilarity(queryEmbedding, doc.embedding);
      results.push({
        score: similarity,
        metadata: doc.metadata,
      });
    }

    // Sort by similarity (descending) and return top K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }

  clear(): void {
    this.documents = [];
    this.embeddings.clear();
  }

  size(): number {
    return this.documents.length;
  }
}

// Singleton instance
const vectorStore = new SimpleVectorStore();

/**
 * Generate embedding for text using OpenAI API
 * Now with caching to avoid redundant API calls
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const perfId = performanceLogger.start('generateEmbedding', {
    textLength: text.length,
  });

  const model = 'text-embedding-3-small';

  // Import cache (dynamic import to avoid circular dependencies)
  const { embeddingCache } = await import('./embedding-cache');

  // Generate cache key
  const cacheKey = embeddingCache.generateHash(text, model);

  // Check cache first
  const cached = await embeddingCache.get(cacheKey);
  if (cached) {
    console.log(`   💾 Using cached embedding (hash: ${cacheKey.substring(0, 8)}...)`);
    performanceLogger.end(perfId, true);
    return cached;
  }

  // Cache miss - generate new embedding
  let embedding: number[];
  let source: 'openai' | 'local' | 'fallback' = 'fallback';
  let tokensUsed = 0;

  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      console.warn('⚠️  OPENAI_API_KEY not set. Using fallback embeddings.');
      embedding = createSimpleEmbedding(text);
      source = 'fallback';
      performanceLogger.end(perfId, true);
    } else {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        const errorMessage = error.error?.message || response.statusText;

        // Check for quota/billing errors
        if (errorMessage.includes('quota') || errorMessage.includes('billing')) {
          console.warn('⚠️  OpenAI API quota exceeded. Using fallback embeddings. This is fine for development.');
          console.warn('   To use OpenAI embeddings: Check your OpenAI billing at https://platform.openai.com/account/billing');
          embedding = createSimpleEmbedding(text);
          source = 'fallback';
          performanceLogger.end(perfId, false, 'Quota exceeded');
        } else {
          console.error('❌ Failed to generate embedding:', errorMessage);
          embedding = createSimpleEmbedding(text);
          source = 'fallback';
          performanceLogger.end(perfId, false, errorMessage);
        }
      } else {
        const data = await response.json();
        embedding = data.data[0].embedding;
        source = 'openai';
        tokensUsed = data.usage?.total_tokens || Math.ceil(text.length / 4); // Estimate if not provided

        // Track cost
        costTracker.totalOpenAICalls++;
        costTracker.totalTokensUsed += tokensUsed;
        // text-embedding-3-small: $0.00002 per 1K tokens
        const costPerToken = 0.00002 / 1000;
        const callCost = tokensUsed * costPerToken;
        costTracker.estimatedCostUSD += callCost;

        console.log(`   ✅ Generated new OpenAI embedding (hash: ${cacheKey.substring(0, 8)}..., tokens: ${tokensUsed}, cost: $${callCost.toFixed(6)})`);
        performanceLogger.end(perfId, true);
      }
    }
  } catch (error: any) {
    // Network errors or other issues
    if (error.message.includes('quota') || error.message.includes('billing')) {
      console.warn('⚠️  OpenAI API quota issue. Using fallback embeddings.');
    } else {
      console.error('❌ Failed to generate embedding:', error.message);
    }
    embedding = createSimpleEmbedding(text);
    source = 'fallback';
    performanceLogger.end(perfId, false, error.message);
  }

  // Cache the embedding (whether from OpenAI or fallback)
  await embeddingCache.set(cacheKey, embedding, {
    text,
    model,
    source,
  });

  return embedding;
}

/**
 * Simple fallback embedding (for development/testing)
 * Creates a basic embedding based on text hash
 */
function createSimpleEmbedding(text: string): number[] {
  // Simple hash-based embedding (not semantic, but works for testing)
  const embedding = new Array(1536).fill(0);
  let hash = 0;
  
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash = hash & hash;
  }
  
  // Distribute hash across embedding dimensions
  for (let i = 0; i < embedding.length; i++) {
    embedding[i] = Math.sin((hash + i) * 0.01) * 0.1;
  }
  
  return embedding;
}

/**
 * Add document to vector store
 */
export async function addToVectorStore(data: {
  id: string;
  embedding: number[];
  metadata: any;
}): Promise<void> {
  try {
    await vectorStore.add({
      id: data.id,
      embedding: data.embedding,
      metadata: data.metadata,
    });
  } catch (error: any) {
    console.error(`❌ Failed to add to vector store:`, error.message);
    throw error;
  }
}

/**
 * Query vector store
 */
export async function queryVectorStore(options: {
  query: string;
  topK?: number;
}): Promise<Array<{ score: number; metadata: any }>> {
  try {
    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(options.query);

    // Query vector store
    const results = await vectorStore.query(queryEmbedding, options.topK || 5);

    return results;
  } catch (error: any) {
    console.error('❌ Failed to query vector store:', error.message);
    return [];
  }
}

/**
 * Initialize vector store (clear existing data)
 */
export function initializeVectorStore(): void {
  vectorStore.clear();
  console.log('✅ Vector store initialized');
}

/**
 * Get vector store size
 */
export function getVectorStoreSize(): number {
  return vectorStore.size();
}

