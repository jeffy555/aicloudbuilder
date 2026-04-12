import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory rate limiter.
 * @param windowMs - Time window in milliseconds
 * @param maxRequests - Max requests per window per key
 * @param keyFn - Function to extract rate limit key from request (default: userId or IP)
 */
export function rateLimit(windowMs: number, maxRequests: number, keyFn?: (req: Request) => string) {
  const store = new Map<string, RateLimitEntry>();

  // Cleanup expired entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    store.forEach((entry, key) => {
      if (now > entry.resetAt) store.delete(key);
    });
  }, 5 * 60 * 1000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn ? keyFn(req) : (req as any).userId || req.ip || 'anonymous';
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfterSeconds: retryAfter,
      });
    }

    entry.count++;
    next();
  };
}

// Pre-configured limiters for common use cases
/** 10 requests per hour per user — for heavy AI endpoints (ScoreMe, ArchMe analyze) */
export const aiHeavyLimiter = rateLimit(60 * 60 * 1000, 10);

/** 30 requests per hour per user — for medium AI endpoints (generate, scan) */
export const aiMediumLimiter = rateLimit(60 * 60 * 1000, 30);

/** 60 requests per hour per user — for light AI endpoints (validate, hints) */
export const aiLightLimiter = rateLimit(60 * 60 * 1000, 60);
