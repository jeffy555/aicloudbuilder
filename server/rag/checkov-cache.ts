/**
 * Checkov Native Cache
 *
 * Phase 3: TTL-based disk cache for Checkov GitHub source files and parsed check definitions.
 * Follows the singleton + fire-and-forget save pattern used by embedding-cache.ts.
 *
 * Cache location: .cache/checkov-native/cache.json
 * Default TTL: 7 days (override via CHECKOV_CACHE_TTL_MS env var)
 */

import { promises as fs } from 'fs';
import { join } from 'path';

export interface InferredRemediation {
  attributeName: string;
  attributeType: 'simple' | 'block';
  expectedValue: any;
  fixSnippet: string;
  confidence: number;
}

interface CachedSource {
  type: 'source';
  checkId: string;
  filePath: string;       // GitHub relative path
  content: string;        // Raw Python source
  fetchedAt: string;      // ISO timestamp
  expiresAt: string;      // ISO timestamp
}

interface CachedParsed {
  type: 'parsed';
  checkId: string;
  resourceType: string;
  checkName: string;
  supportedResources: string[];
  guidelineUrl: string | null;
  inferredRemediation: InferredRemediation | null;
  fetchedAt: string;
  expiresAt: string;
}

type CacheEntry = CachedSource | CachedParsed;

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class CheckovCache {
  private cacheDir: string;
  private cache: Map<string, CacheEntry> = new Map();
  private initialized = false;

  constructor(cacheDir: string = '.cache/checkov-native') {
    this.cacheDir = cacheDir;
  }

  private get ttlMs(): number {
    const env = process.env.CHECKOV_CACHE_TTL_MS;
    if (env !== undefined && env !== '') {
      const parsed = parseInt(env, 10);
      if (!isNaN(parsed)) return parsed;
    }
    return DEFAULT_TTL_MS;
  }

  private isExpired(entry: CacheEntry): boolean {
    return new Date(entry.expiresAt) < new Date();
  }

  private sourceKey(checkId: string): string {
    return `source:${checkId}`;
  }

  private parsedKey(checkId: string, resourceType: string): string {
    return `parsed:${checkId}:${resourceType}`;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.initialized) {
      await this.loadFromDisk();
    }
  }

  /**
   * Load cache entries from disk on first access
   */
  async loadFromDisk(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const cacheFile = join(this.cacheDir, 'cache.json');

      try {
        const data = await fs.readFile(cacheFile, 'utf-8');
        const entries: CacheEntry[] = JSON.parse(data);

        for (const entry of entries) {
          const key = entry.type === 'source'
            ? this.sourceKey(entry.checkId)
            : this.parsedKey(entry.checkId, entry.resourceType);
          this.cache.set(key, entry);
        }
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.warn('⚠️  Failed to load Checkov cache:', error.message);
        }
      }

      this.initialized = true;
    } catch (error: any) {
      console.warn('⚠️  Failed to initialize Checkov cache:', error.message);
      this.initialized = true;
    }
  }

  /**
   * Persist cache to disk asynchronously (fire-and-forget)
   */
  private saveToDisk(): void {
    (async () => {
      try {
        await fs.mkdir(this.cacheDir, { recursive: true });
        const cacheFile = join(this.cacheDir, 'cache.json');
        const entries = Array.from(this.cache.values());
        await fs.writeFile(cacheFile, JSON.stringify(entries, null, 2), 'utf-8');
      } catch (error: any) {
        console.warn('⚠️  Failed to save Checkov cache:', error.message);
      }
    })();
  }

  // --- Source entries (raw GitHub Python file) ---

  async getSource(checkId: string): Promise<CachedSource | null> {
    await this.ensureLoaded();
    const entry = this.cache.get(this.sourceKey(checkId));
    if (!entry || entry.type !== 'source') return null;
    if (this.isExpired(entry)) {
      this.cache.delete(this.sourceKey(checkId));
      return null;
    }
    return entry;
  }

  async setSource(checkId: string, filePath: string, content: string): Promise<void> {
    await this.ensureLoaded();
    const now = new Date();
    const entry: CachedSource = {
      type: 'source',
      checkId,
      filePath,
      content,
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    this.cache.set(this.sourceKey(checkId), entry);
    this.saveToDisk();
  }

  // --- Parsed entries (extracted definition + inferred remediation) ---

  async getParsed(checkId: string, resourceType: string): Promise<CachedParsed | null> {
    await this.ensureLoaded();
    const entry = this.cache.get(this.parsedKey(checkId, resourceType));
    if (!entry || entry.type !== 'parsed') return null;
    if (this.isExpired(entry)) {
      this.cache.delete(this.parsedKey(checkId, resourceType));
      return null;
    }
    return entry;
  }

  async setParsed(
    checkId: string,
    resourceType: string,
    data: Pick<CachedParsed, 'checkId' | 'resourceType' | 'checkName' | 'supportedResources' | 'guidelineUrl' | 'inferredRemediation'>
  ): Promise<void> {
    await this.ensureLoaded();
    const now = new Date();
    const entry: CachedParsed = {
      ...data,
      type: 'parsed',
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    this.cache.set(this.parsedKey(checkId, resourceType), entry);
    this.saveToDisk();
  }

  // --- Stats and management ---

  getStats(): { sourceCount: number; parsedCount: number; expiredCount: number } {
    let sourceCount = 0;
    let parsedCount = 0;
    let expiredCount = 0;

    for (const entry of this.cache.values()) {
      if (this.isExpired(entry)) {
        expiredCount++;
      } else if (entry.type === 'source') {
        sourceCount++;
      } else {
        parsedCount++;
      }
    }

    return { sourceCount, parsedCount, expiredCount };
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.cache.clear();
    const cacheFile = join(this.cacheDir, 'cache.json');
    try {
      await fs.unlink(cacheFile);
    } catch {
      // File might not exist
    }
  }
}

const checkovCache = new CheckovCache(
  process.env.CHECKOV_CACHE_DIR || '.cache/checkov-native'
);

export { checkovCache, CheckovCache };
export type { CachedSource, CachedParsed, CacheEntry };
