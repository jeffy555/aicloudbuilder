/**
 * Embedding Cache Manager
 * 
 * Persists embeddings to disk to avoid regenerating them on every server restart.
 * Uses SHA-256 hash of text + model name as cache key.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

interface CachedEmbedding {
  hash: string;
  text: string;
  model: string;
  embedding: number[];
  created_at: string;
  source: 'openai' | 'local' | 'fallback';
}

class EmbeddingCache {
  private cacheDir: string;
  private cache: Map<string, CachedEmbedding> = new Map();
  private initialized = false;

  constructor(cacheDir: string = '.cache/embeddings') {
    this.cacheDir = cacheDir;
  }

  /**
   * Generate cache key from text and model name
   */
  generateHash(text: string, model: string): string {
    const combined = `${model}:${text}`;
    return createHash('sha256').update(combined).digest('hex');
  }

  /**
   * Get cached embedding if it exists
   */
  async get(hash: string): Promise<number[] | null> {
    if (!this.initialized) {
      await this.loadFromDisk();
    }

    const cached = this.cache.get(hash);
    if (cached) {
      return cached.embedding;
    }

    return null;
  }

  /**
   * Store embedding in cache
   */
  async set(
    hash: string,
    embedding: number[],
    metadata: {
      text: string;
      model: string;
      source: 'openai' | 'local' | 'fallback';
    }
  ): Promise<void> {
    const cached: CachedEmbedding = {
      hash,
      text: metadata.text,
      model: metadata.model,
      embedding,
      created_at: new Date().toISOString(),
      source: metadata.source,
    };

    this.cache.set(hash, cached);

    // Save to disk asynchronously (don't block)
    this.saveToDisk().catch((error) => {
      console.warn('⚠️  Failed to save embedding cache to disk:', error.message);
    });
  }

  /**
   * Load cache from disk
   */
  async loadFromDisk(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure cache directory exists
      await fs.mkdir(this.cacheDir, { recursive: true });

      const cacheFile = join(this.cacheDir, 'embeddings.json');

      try {
        const data = await fs.readFile(cacheFile, 'utf-8');
        const cached: CachedEmbedding[] = JSON.parse(data);

        // Load into memory
        for (const item of cached) {
          this.cache.set(item.hash, item);
        }

        // loaded — stats available via getStats()
      } catch (error: any) {
        // File doesn't exist yet, that's okay
        if (error.code !== 'ENOENT') {
          console.warn('⚠️  Failed to load embedding cache:', error.message);
        }
      }

      this.initialized = true;
    } catch (error: any) {
      console.warn('⚠️  Failed to initialize embedding cache:', error.message);
      this.initialized = true; // Mark as initialized to avoid retry loops
    }
  }

  /**
   * Save cache to disk
   */
  private async saveToDisk(): Promise<void> {
    try {
      // Ensure cache directory exists
      await fs.mkdir(this.cacheDir, { recursive: true });

      const cacheFile = join(this.cacheDir, 'embeddings.json');
      const cached = Array.from(this.cache.values());

      await fs.writeFile(cacheFile, JSON.stringify(cached, null, 2), 'utf-8');
    } catch (error: any) {
      throw new Error(`Failed to save cache: ${error.message}`);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { total: number; bySource: Record<string, number> } {
    const bySource: Record<string, number> = {};
    
    for (const item of this.cache.values()) {
      bySource[item.source] = (bySource[item.source] || 0) + 1;
    }

    return {
      total: this.cache.size,
      bySource,
    };
  }

  /**
   * Clear cache (useful for testing or reset)
   */
  async clear(): Promise<void> {
    this.cache.clear();
    const cacheFile = join(this.cacheDir, 'embeddings.json');
    try {
      await fs.unlink(cacheFile);
    } catch (error: any) {
      // File might not exist, that's okay
    }
  }
}

// Singleton instance
const embeddingCache = new EmbeddingCache(
  process.env.EMBEDDING_CACHE_DIR || '.cache/embeddings'
);

export { embeddingCache, EmbeddingCache };
export type { CachedEmbedding };




