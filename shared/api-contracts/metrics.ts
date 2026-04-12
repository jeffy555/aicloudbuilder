import { z } from "zod";

// GET /api/metrics/performance
export const metricsPerformanceResponse = z.any().openapi("MetricsPerformanceResponse");

// GET /api/metrics/performance/recent
export const metricsRecentResponse = z.any().openapi("MetricsRecentResponse");

// GET /api/metrics/cache
export const metricsCacheResponse = z.any().openapi("MetricsCacheResponse");

// GET /api/metrics/ai-usage
export const metricsAiUsageResponse = z.any().openapi("MetricsAiUsageResponse");

// GET /api/metrics/dashboard
export const metricsDashboardResponse = z.any().openapi("MetricsDashboardResponse");

// POST /api/metrics/reset
export const metricsResetResponse = z.object({
  success: z.boolean(),
  message: z.string(),
}).openapi("MetricsResetResponse");

// GET /api/metrics/baseline
export const metricsBaselineResponse = z.any().openapi("MetricsBaselineResponse");

// GET /api/metrics/feature-flags
export const metricsFeatureFlagsResponse = z.any().openapi("MetricsFeatureFlagsResponse");
