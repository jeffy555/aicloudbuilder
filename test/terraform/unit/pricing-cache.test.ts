/**
 * B2: Pricing cache TTL expiry
 *
 * Tests getCachedPricing / setCachedPricing:
 *   - Returns cached result within TTL window
 *   - Returns null after TTL expires
 *   - Different filter keys are stored independently
 */

import { vi } from 'vitest';
import { getCachedPricing, setCachedPricing, getPricingCacheStats } from '../../../server/utils/pricing-cache.js';

describe('pricing cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns items immediately after storing them', () => {
    const items = [{ retailPrice: 0.096, skuName: 'B2s' }];
    setCachedPricing('test-filter-1', items);
    const result = getCachedPricing('test-filter-1');
    expect(result).toEqual(items);
  });

  it('returns null for unknown filter key', () => {
    const result = getCachedPricing('filter-that-was-never-set');
    expect(result).toBeNull();
  });

  it('returns cached result within TTL window (59 minutes)', () => {
    const items = [{ retailPrice: 0.096, skuName: 'B2s' }];
    setCachedPricing('test-filter-2', items);

    // Advance 59 minutes — still within 1-hour TTL
    vi.advanceTimersByTime(59 * 60 * 1000);

    const result = getCachedPricing('test-filter-2');
    expect(result).toEqual(items);
  });

  it('returns null after TTL expires (61 minutes)', () => {
    const items = [{ retailPrice: 0.096, skuName: 'B2s' }];
    setCachedPricing('test-filter-3', items);

    // Advance 61 minutes — past the 1-hour TTL
    vi.advanceTimersByTime(61 * 60 * 1000);

    const result = getCachedPricing('test-filter-3');
    expect(result).toBeNull();
  });

  it('stores different filter keys independently', () => {
    const items1 = [{ retailPrice: 0.096, skuName: 'B2s' }];
    const items2 = [{ retailPrice: 0.192, skuName: 'D4s v3' }];

    setCachedPricing('filter-a', items1);
    setCachedPricing('filter-b', items2);

    expect(getCachedPricing('filter-a')).toEqual(items1);
    expect(getCachedPricing('filter-b')).toEqual(items2);
  });

  it('getPricingCacheStats returns ttlHours = 1', () => {
    const stats = getPricingCacheStats();
    expect(stats.ttlHours).toBe(1);
  });
});
