#!/usr/bin/env tsx
/**
 * Phase 0: Baseline Analysis Script
 *
 * Analyzes current system state before implementing intelligent fix system
 *
 * Generates:
 * - AI API call statistics
 * - Fix retrieval performance metrics
 * - Success rate analysis
 * - Checkov check coverage
 */

import fs from 'fs/promises';
import path from 'path';

interface FixLog {
  id: string;
  sessionId: string;
  checkId: string;
  source: 'retrieved' | 'generated' | 'template' | 'manual';
  confidence: number;
  timestamp: string;
  verified?: boolean;
  success?: boolean;
  responseTimeMs?: number;
}

interface FixSnippet {
  id: string;
  checkId: string;
  resourceType: string;
  cloudProvider: string;
  fixSnippet: string;
  source: string;
  confidence: number;
  successCount: number;
  failureCount: number;
  verified: boolean;
  deprecated: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EmbeddingCacheEntry {
  hash: string;
  embedding: number[];
  metadata: {
    text: string;
    model: string;
    source: 'openai' | 'local' | 'fallback';
  };
  timestamp: string;
}

interface BaselineMetrics {
  timestamp: string;
  aiApiCalls: {
    totalEmbeddingCalls: number;
    openaiCalls: number;
    fallbackCalls: number;
    cacheHitRate: number;
    estimatedMonthlyCost: number;
  };
  fixRetrieval: {
    totalFixes: number;
    averageResponseTimeMs: number;
    bySource: Record<string, number>;
    bySourcePercentage: Record<string, string>;
  };
  successRate: {
    totalVerified: number;
    successful: number;
    failed: number;
    successRate: string;
    unverified: number;
  };
  checkovCoverage: {
    totalChecks: number;
    uniqueCheckIds: string[];
    byCloudProvider: Record<string, number>;
    topChecks: Array<{ checkId: string; count: number }>;
  };
  cacheStats: {
    fixSnippetsSize: string;
    embeddingCacheSize: string;
    fixLogsSize: string;
    totalCacheSizeMB: number;
  };
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (error) {
    return 0;
  }
}

async function formatFileSize(bytes: number): Promise<string> {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

async function loadJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`⚠️  Could not read ${filePath}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function analyzeFixLogs(): Promise<{ logs: FixLog[]; metrics: any }> {
  const logsPath = path.join(process.cwd(), '.cache', 'fix-logs.json');
  const data = await loadJsonFile<{ logs: FixLog[] }>(logsPath);

  if (!data || !data.logs) {
    return {
      logs: [],
      metrics: {
        totalFixes: 0,
        bySource: {},
        averageResponseTimeMs: 0,
        successful: 0,
        failed: 0,
        unverified: 0,
      },
    };
  }

  const logs = data.logs;
  const bySource: Record<string, number> = {};
  let totalResponseTime = 0;
  let responseTimes = 0;
  let successful = 0;
  let failed = 0;
  let unverified = 0;

  for (const log of logs) {
    // Count by source
    bySource[log.source] = (bySource[log.source] || 0) + 1;

    // Track response times
    if (log.responseTimeMs) {
      totalResponseTime += log.responseTimeMs;
      responseTimes++;
    }

    // Track success/failure
    if (log.verified !== undefined) {
      if (log.verified) successful++;
      else failed++;
    } else {
      unverified++;
    }
  }

  return {
    logs,
    metrics: {
      totalFixes: logs.length,
      bySource,
      averageResponseTimeMs: responseTimes > 0 ? totalResponseTime / responseTimes : 0,
      successful,
      failed,
      unverified,
    },
  };
}

async function analyzeFixSnippets(): Promise<{ snippets: FixSnippet[]; metrics: any }> {
  const snippetsPath = path.join(process.cwd(), '.cache', 'fix-snippets.json');
  const data = await loadJsonFile<{ snippets: FixSnippet[] }>(snippetsPath);

  if (!data || !Array.isArray(data)) {
    return {
      snippets: [],
      metrics: {
        total: 0,
        active: 0,
        deprecated: 0,
        verified: 0,
      },
    };
  }

  // Handle both array and object with snippets property
  const snippets = Array.isArray(data) ? data : (data as any).snippets || [];

  const active = snippets.filter((s: FixSnippet) => !s.deprecated).length;
  const deprecated = snippets.filter((s: FixSnippet) => s.deprecated).length;
  const verified = snippets.filter((s: FixSnippet) => s.verified).length;

  return {
    snippets,
    metrics: {
      total: snippets.length,
      active,
      deprecated,
      verified,
    },
  };
}

async function analyzeEmbeddingCache(): Promise<{ entries: number; openaiCalls: number; fallbackCalls: number }> {
  const cachePath = path.join(process.cwd(), '.cache', 'embeddings', 'embeddings.json');
  const data = await loadJsonFile<Record<string, EmbeddingCacheEntry>>(cachePath);

  if (!data) {
    return { entries: 0, openaiCalls: 0, fallbackCalls: 0 };
  }

  const entries = Object.keys(data).length;
  let openaiCalls = 0;
  let fallbackCalls = 0;

  for (const entry of Object.values(data)) {
    if (entry && entry.metadata && entry.metadata.source) {
      if (entry.metadata.source === 'openai') {
        openaiCalls++;
      } else if (entry.metadata.source === 'fallback') {
        fallbackCalls++;
      }
    }
  }

  return { entries, openaiCalls, fallbackCalls };
}

async function analyzeCheckovCoverage(logs: FixLog[]): Promise<any> {
  const checkIds = new Set<string>();
  const byCloudProvider: Record<string, number> = {};
  const checkCounts: Record<string, number> = {};

  for (const log of logs) {
    checkIds.add(log.checkId);
    checkCounts[log.checkId] = (checkCounts[log.checkId] || 0) + 1;

    // Extract cloud provider from check ID (e.g., CKV_AZURE_59 -> AZURE)
    const parts = log.checkId.split('_');
    if (parts.length >= 2) {
      const provider = parts[1];
      byCloudProvider[provider] = (byCloudProvider[provider] || 0) + 1;
    }
  }

  // Top 10 most common checks
  const topChecks = Object.entries(checkCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([checkId, count]) => ({ checkId, count }));

  return {
    totalChecks: checkIds.size,
    uniqueCheckIds: Array.from(checkIds).sort(),
    byCloudProvider,
    topChecks,
  };
}

async function generateBaselineMetrics(): Promise<BaselineMetrics> {
  console.log('📊 Starting baseline analysis...\n');

  // Analyze fix logs
  console.log('🔍 Analyzing fix logs...');
  const { logs, metrics: fixMetrics } = await analyzeFixLogs();
  console.log(`   Found ${fixMetrics.totalFixes} fix operations`);

  // Analyze fix snippets
  console.log('🔍 Analyzing fix snippets...');
  const { metrics: snippetMetrics } = await analyzeFixSnippets();
  console.log(`   Found ${snippetMetrics.total} fix snippets (${snippetMetrics.active} active)`);

  // Analyze embedding cache
  console.log('🔍 Analyzing embedding cache...');
  const embeddingStats = await analyzeEmbeddingCache();
  console.log(`   Found ${embeddingStats.entries} cached embeddings`);

  // Analyze Checkov coverage
  console.log('🔍 Analyzing Checkov coverage...');
  const checkovCoverage = await analyzeCheckovCoverage(logs);
  console.log(`   Covering ${checkovCoverage.totalChecks} unique Checkov checks`);

  // Calculate cache sizes
  console.log('🔍 Calculating cache sizes...');
  const fixSnippetsSize = await getFileSize(path.join(process.cwd(), '.cache', 'fix-snippets.json'));
  const embeddingCacheSize = await getFileSize(path.join(process.cwd(), '.cache', 'embeddings', 'embeddings.json'));
  const fixLogsSize = await getFileSize(path.join(process.cwd(), '.cache', 'fix-logs.json'));
  const totalCacheSizeMB = (fixSnippetsSize + embeddingCacheSize + fixLogsSize) / (1024 * 1024);

  // Calculate percentages
  const bySourcePercentage: Record<string, string> = {};
  for (const [source, count] of Object.entries(fixMetrics.bySource)) {
    const countNum = typeof count === 'number' ? count : 0;
    bySourcePercentage[source] = `${((countNum / fixMetrics.totalFixes) * 100).toFixed(1)}%`;
  }

  // Estimate costs
  // OpenAI text-embedding-3-small: $0.00002 per 1K tokens (~750 words)
  // Assume average of 200 tokens per embedding
  const estimatedCostPerEmbedding = 0.00002 * 0.2; // $0.000004 per embedding
  const estimatedMonthlyCost = embeddingStats.openaiCalls * estimatedCostPerEmbedding * 30; // Extrapolate

  const metrics: BaselineMetrics = {
    timestamp: new Date().toISOString(),
    aiApiCalls: {
      totalEmbeddingCalls: embeddingStats.entries,
      openaiCalls: embeddingStats.openaiCalls,
      fallbackCalls: embeddingStats.fallbackCalls,
      cacheHitRate: embeddingStats.entries > 0
        ? parseFloat(((embeddingStats.openaiCalls / embeddingStats.entries) * 100).toFixed(1))
        : 0,
      estimatedMonthlyCost,
    },
    fixRetrieval: {
      totalFixes: fixMetrics.totalFixes,
      averageResponseTimeMs: Math.round(fixMetrics.averageResponseTimeMs),
      bySource: fixMetrics.bySource,
      bySourcePercentage,
    },
    successRate: {
      totalVerified: fixMetrics.successful + fixMetrics.failed,
      successful: fixMetrics.successful,
      failed: fixMetrics.failed,
      successRate: fixMetrics.successful + fixMetrics.failed > 0
        ? `${((fixMetrics.successful / (fixMetrics.successful + fixMetrics.failed)) * 100).toFixed(1)}%`
        : 'N/A',
      unverified: fixMetrics.unverified,
    },
    checkovCoverage,
    cacheStats: {
      fixSnippetsSize: await formatFileSize(fixSnippetsSize),
      embeddingCacheSize: await formatFileSize(embeddingCacheSize),
      fixLogsSize: await formatFileSize(fixLogsSize),
      totalCacheSizeMB: parseFloat(totalCacheSizeMB.toFixed(2)),
    },
  };

  return metrics;
}

async function printReport(metrics: BaselineMetrics): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('📊 BASELINE METRICS REPORT');
  console.log('='.repeat(70));
  console.log(`Generated: ${new Date(metrics.timestamp).toLocaleString()}\n`);

  console.log('🤖 AI API CALLS (Embeddings)');
  console.log('─'.repeat(70));
  console.log(`   Total embedding calls: ${metrics.aiApiCalls.totalEmbeddingCalls}`);
  console.log(`   OpenAI API calls: ${metrics.aiApiCalls.openaiCalls}`);
  console.log(`   Fallback calls: ${metrics.aiApiCalls.fallbackCalls}`);
  console.log(`   Cache effectiveness: ${100 - metrics.aiApiCalls.cacheHitRate}% saved`);
  console.log(`   Est. monthly cost: $${metrics.aiApiCalls.estimatedMonthlyCost.toFixed(3)}\n`);

  console.log('🔧 FIX RETRIEVAL PERFORMANCE');
  console.log('─'.repeat(70));
  console.log(`   Total fixes applied: ${metrics.fixRetrieval.totalFixes}`);
  console.log(`   Avg response time: ${metrics.fixRetrieval.averageResponseTimeMs}ms`);
  console.log('   By source:');
  for (const [source, count] of Object.entries(metrics.fixRetrieval.bySource)) {
    const percentage = metrics.fixRetrieval.bySourcePercentage[source];
    console.log(`      ${source}: ${count} (${percentage})`);
  }
  console.log('');

  console.log('✅ SUCCESS RATE');
  console.log('─'.repeat(70));
  console.log(`   Total verified: ${metrics.successRate.totalVerified}`);
  console.log(`   Successful: ${metrics.successRate.successful}`);
  console.log(`   Failed: ${metrics.successRate.failed}`);
  console.log(`   Success rate: ${metrics.successRate.successRate}`);
  console.log(`   Unverified: ${metrics.successRate.unverified}\n`);

  console.log('🎯 CHECKOV COVERAGE');
  console.log('─'.repeat(70));
  console.log(`   Unique checks handled: ${metrics.checkovCoverage.totalChecks}`);
  console.log('   By cloud provider:');
  for (const [provider, count] of Object.entries(metrics.checkovCoverage.byCloudProvider)) {
    console.log(`      ${provider}: ${count}`);
  }
  console.log('   Top 10 most common checks:');
  for (const { checkId, count } of metrics.checkovCoverage.topChecks) {
    console.log(`      ${checkId}: ${count}×`);
  }
  console.log('');

  console.log('💾 CACHE STATISTICS');
  console.log('─'.repeat(70));
  console.log(`   Fix snippets: ${metrics.cacheStats.fixSnippetsSize}`);
  console.log(`   Embeddings: ${metrics.cacheStats.embeddingCacheSize}`);
  console.log(`   Fix logs: ${metrics.cacheStats.fixLogsSize}`);
  console.log(`   Total cache: ${metrics.cacheStats.totalCacheSizeMB} MB\n`);

  console.log('='.repeat(70));
}

async function saveReport(metrics: BaselineMetrics): Promise<void> {
  const outputDir = path.join(process.cwd(), 'docs', 'metrics');
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'baseline-metrics.json');
  await fs.writeFile(outputPath, JSON.stringify(metrics, null, 2));
  console.log(`✅ Baseline metrics saved to: ${outputPath}`);

  // Also save markdown report
  const mdPath = path.join(outputDir, 'baseline-report.md');
  const mdContent = generateMarkdownReport(metrics);
  await fs.writeFile(mdPath, mdContent);
  console.log(`✅ Markdown report saved to: ${mdPath}`);
}

function generateMarkdownReport(metrics: BaselineMetrics): string {
  return `# Baseline Metrics Report

**Generated:** ${new Date(metrics.timestamp).toLocaleString()}

## AI API Calls (Embeddings)

- **Total embedding calls:** ${metrics.aiApiCalls.totalEmbeddingCalls}
- **OpenAI API calls:** ${metrics.aiApiCalls.openaiCalls}
- **Fallback calls:** ${metrics.aiApiCalls.fallbackCalls}
- **Cache effectiveness:** ${100 - metrics.aiApiCalls.cacheHitRate}% saved
- **Est. monthly cost:** $${metrics.aiApiCalls.estimatedMonthlyCost.toFixed(3)}

## Fix Retrieval Performance

- **Total fixes applied:** ${metrics.fixRetrieval.totalFixes}
- **Average response time:** ${metrics.fixRetrieval.averageResponseTimeMs}ms

### By Source
${Object.entries(metrics.fixRetrieval.bySource).map(([source, count]) =>
  `- **${source}:** ${count} (${metrics.fixRetrieval.bySourcePercentage[source]})`
).join('\n')}

## Success Rate

- **Total verified:** ${metrics.successRate.totalVerified}
- **Successful:** ${metrics.successRate.successful}
- **Failed:** ${metrics.successRate.failed}
- **Success rate:** ${metrics.successRate.successRate}
- **Unverified:** ${metrics.successRate.unverified}

## Checkov Coverage

- **Unique checks handled:** ${metrics.checkovCoverage.totalChecks}

### By Cloud Provider
${Object.entries(metrics.checkovCoverage.byCloudProvider).map(([provider, count]) =>
  `- **${provider}:** ${count}`
).join('\n')}

### Top 10 Most Common Checks
${metrics.checkovCoverage.topChecks.map(({ checkId, count }) =>
  `- ${checkId}: ${count}×`
).join('\n')}

## Cache Statistics

- **Fix snippets:** ${metrics.cacheStats.fixSnippetsSize}
- **Embeddings:** ${metrics.cacheStats.embeddingCacheSize}
- **Fix logs:** ${metrics.cacheStats.fixLogsSize}
- **Total cache:** ${metrics.cacheStats.totalCacheSizeMB} MB

---

*This baseline report will be used to measure the impact of the intelligent fix system implementation.*
`;
}

// Main execution
async function main() {
  try {
    const metrics = await generateBaselineMetrics();
    await printReport(metrics);
    await saveReport(metrics);

    console.log('\n✅ Baseline analysis complete!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Baseline analysis failed:', error);
    process.exit(1);
  }
}

main();
