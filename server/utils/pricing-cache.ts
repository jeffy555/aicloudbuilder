/**
 * In-memory TTL cache for Azure Pricing API responses.
 * Keyed by the OData filter string so identical queries are never re-fetched
 * within the TTL window. This eliminates N sequential HTTP calls for N resources
 * on every /analyze-cost request.
 */

interface CacheEntry {
  items: any[];
  expiresAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map<string, CacheEntry>();

function isExpired(entry: CacheEntry): boolean {
  return Date.now() > entry.expiresAt;
}

function prune(): void {
  cache.forEach((entry, key) => {
    if (isExpired(entry)) cache.delete(key);
  });
}

export function getCachedPricing(filter: string): any[] | null {
  const entry = cache.get(filter);
  if (!entry || isExpired(entry)) {
    if (entry) cache.delete(filter);
    return null;
  }
  return entry.items;
}

export function setCachedPricing(filter: string, items: any[]): void {
  // Prune stale entries occasionally to avoid unbounded growth
  if (cache.size % 50 === 0) prune();
  cache.set(filter, { items, expiresAt: Date.now() + TTL_MS });
}

export function getPricingCacheStats(): { size: number; ttlHours: number } {
  return { size: cache.size, ttlHours: TTL_MS / 3_600_000 };
}
