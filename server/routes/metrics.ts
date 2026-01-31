/**
 * Metrics Dashboard Routes
 *
 * Phase 0: Monitoring endpoints for baseline and ongoing metrics
 */

import type { Express } from 'express';
import { performanceLogger } from '../utils/performance-logger';
import { fixSnippetStore } from '../rag/fix-snippet-store';
import { getVectorStoreSize, getCostStats } from '../rag/vector-store';
import { getFeatureFlagStatus } from '../middleware/feature-flags';
import fs from 'fs/promises';
import path from 'path';

export function registerMetricsRoutes(app: Express) {
  /**
   * GET /api/metrics/performance
   * Real-time performance metrics
   */
  app.get('/api/metrics/performance', async (req, res) => {
    try {
      const operation = req.query.operation as string | undefined;

      const stats = performanceLogger.getStats(operation);
      const summary = performanceLogger.getSummary();

      res.json({
        summary,
        stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/metrics/performance/recent
   * Recent performance metrics (last N operations)
   */
  app.get('/api/metrics/performance/recent', async (req, res) => {
    try {
      const count = parseInt(req.query.count as string) || 100;
      const recent = performanceLogger.getRecentMetrics(count);

      res.json({
        metrics: recent,
        count: recent.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/metrics/cache
   * Cache statistics (fix snippets, vector store, etc.)
   */
  app.get('/api/metrics/cache', async (req, res) => {
    try {
      const snippetStats = fixSnippetStore.getStats();
      const vectorStoreSize = getVectorStoreSize();

      // Get cache file sizes
      const cacheDir = path.join(process.cwd(), '.cache');
      const fixSnippetsPath = path.join(cacheDir, 'fix-snippets.json');
      const embeddingsPath = path.join(cacheDir, 'embeddings', 'embeddings.json');
      const fixLogsPath = path.join(cacheDir, 'fix-logs.json');

      const [fixSnippetsSize, embeddingsSize, fixLogsSize] = await Promise.all([
        getFileSize(fixSnippetsPath),
        getFileSize(embeddingsPath),
        getFileSize(fixLogsPath),
      ]);

      res.json({
        fixSnippets: {
          ...snippetStats,
          fileSizeBytes: fixSnippetsSize,
          fileSizeMB: (fixSnippetsSize / (1024 * 1024)).toFixed(2),
        },
        vectorStore: {
          size: vectorStoreSize,
          fileSizeBytes: embeddingsSize,
          fileSizeMB: (embeddingsSize / (1024 * 1024)).toFixed(2),
        },
        fixLogs: {
          fileSizeBytes: fixLogsSize,
          fileSizeMB: (fixLogsSize / (1024 * 1024)).toFixed(2),
        },
        totalCacheSizeMB: ((fixSnippetsSize + embeddingsSize + fixLogsSize) / (1024 * 1024)).toFixed(2),
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/metrics/ai-usage
   * AI API usage and cost tracking
   */
  app.get('/api/metrics/ai-usage', async (req, res) => {
    try {
      // Get embedding generation stats from performance logger
      const embeddingStats = performanceLogger.getStats('generateEmbedding');
      const stats = embeddingStats.length > 0 ? embeddingStats[0] : null;

      // Get real-time cost tracking
      const costStats = getCostStats();

      // Load embedding cache to get source breakdown
      const cachePath = path.join(process.cwd(), '.cache', 'embeddings', 'embeddings.json');
      let openaiCalls = costStats.totalOpenAICalls;
      let fallbackCalls = 0;
      let totalEmbeddings = 0;

      try {
        const cacheContent = await fs.readFile(cachePath, 'utf-8');
        const cache = JSON.parse(cacheContent);
        totalEmbeddings = Object.keys(cache).length;

        for (const entry of Object.values(cache) as any[]) {
          if (entry?.metadata?.source === 'fallback') {
            fallbackCalls++;
          }
        }
      } catch (error) {
        // Cache file might not exist yet
      }

      // Calculate savings from caching
      const cacheHits = totalEmbeddings - openaiCalls;
      const costPerCall = costStats.totalOpenAICalls > 0
        ? costStats.estimatedCostUSD / costStats.totalOpenAICalls
        : 0.000004; // Default estimate
      const savedCost = cacheHits * costPerCall;

      res.json({
        embeddings: {
          total: totalEmbeddings,
          openai: openaiCalls,
          fallback: fallbackCalls,
          cacheHits,
          cacheHitRate: totalEmbeddings > 0
            ? `${((cacheHits / totalEmbeddings) * 100).toFixed(1)}%`
            : 'N/A',
        },
        performance: stats ? {
          averageMs: stats.averageDurationMs.toFixed(2),
          minMs: stats.minDurationMs,
          maxMs: stats.maxDurationMs,
        } : null,
        cost: {
          totalCost: `$${costStats.estimatedCostUSD.toFixed(6)}`,
          totalTokensUsed: costStats.totalTokensUsed,
          savedFromCache: `$${savedCost.toFixed(6)}`,
          estimatedMonthlyCost: `$${(costStats.estimatedCostUSD * 30).toFixed(3)}`,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/metrics/dashboard
   * Combined dashboard view with all key metrics
   */
  app.get('/api/metrics/dashboard', async (req, res) => {
    try {
      // Gather all metrics
      const perfSummary = performanceLogger.getSummary();
      const snippetStats = fixSnippetStore.getStats();
      const vectorStoreSize = getVectorStoreSize();

      // Performance stats for key operations
      const findRemediationStats = performanceLogger.getStats('findRemediation');
      const exactMatchStats = performanceLogger.getStats('findRemediation.exactMatch');
      const semanticSearchStats = performanceLogger.getStats('findRemediation.semanticSearch');

      // AI usage
      const embeddingStats = performanceLogger.getStats('generateEmbedding');

      res.json({
        overview: {
          totalOperations: perfSummary.totalOperations,
          operationTypes: perfSummary.operationTypes,
          averageResponseMs: perfSummary.averageDurationMs.toFixed(2),
          successRate: `${(perfSummary.successRate * 100).toFixed(1)}%`,
          activeOperations: perfSummary.activeOperations,
        },
        fixRetrieval: {
          findRemediation: findRemediationStats.length > 0 ? {
            count: findRemediationStats[0].count,
            averageMs: findRemediationStats[0].averageDurationMs.toFixed(2),
            successRate: `${((findRemediationStats[0].successCount / findRemediationStats[0].count) * 100).toFixed(1)}%`,
          } : null,
          exactMatch: exactMatchStats.length > 0 ? {
            count: exactMatchStats[0].count,
            averageMs: exactMatchStats[0].averageDurationMs.toFixed(2),
          } : null,
          semanticSearch: semanticSearchStats.length > 0 ? {
            count: semanticSearchStats[0].count,
            averageMs: semanticSearchStats[0].averageDurationMs.toFixed(2),
          } : null,
        },
        cache: {
          fixSnippets: snippetStats,
          vectorStoreSize,
        },
        aiUsage: embeddingStats.length > 0 ? {
          count: embeddingStats[0].count,
          averageMs: embeddingStats[0].averageDurationMs.toFixed(2),
        } : null,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/metrics/reset
   * Reset performance metrics (for testing)
   */
  app.post('/api/metrics/reset', async (req, res) => {
    try {
      performanceLogger.clear();
      res.json({
        success: true,
        message: 'Performance metrics cleared',
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/metrics/baseline
   * Get baseline metrics from Phase 0 analysis
   */
  app.get('/api/metrics/baseline', async (req, res) => {
    try {
      const baselinePath = path.join(process.cwd(), 'docs', 'metrics', 'baseline-metrics.json');
      const baselineContent = await fs.readFile(baselinePath, 'utf-8');
      const baseline = JSON.parse(baselineContent);

      res.json(baseline);
    } catch (error: any) {
      if ((error as any).code === 'ENOENT') {
        res.status(404).json({
          error: 'Baseline metrics not found',
          message: 'Run: npx tsx server/scripts/baseline-analysis.ts',
        });
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  });

  /**
   * GET /api/metrics/feature-flags
   * Get current feature flag status
   */
  app.get('/api/metrics/feature-flags', getFeatureFlagStatus);
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (error) {
    return 0;
  }
}
