/**
 * Performance Logger for Phase 0 Monitoring
 *
 * Tracks performance metrics for fix retrieval and AI API calls
 */

export interface PerformanceMetric {
  operation: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  metadata?: Record<string, any>;
  success?: boolean;
  error?: string;
}

export interface PerformanceStats {
  operation: string;
  count: number;
  totalDurationMs: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  successCount: number;
  failureCount: number;
}

class PerformanceLogger {
  private metrics: PerformanceMetric[] = [];
  private activeOperations: Map<string, PerformanceMetric> = new Map();
  private readonly MAX_METRICS = 10000; // Keep last 10k metrics in memory

  /**
   * Start tracking an operation
   */
  start(operation: string, metadata?: Record<string, any>): string {
    const operationId = `${operation}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const metric: PerformanceMetric = {
      operation,
      startTime: Date.now(),
      metadata,
    };

    this.activeOperations.set(operationId, metric);
    return operationId;
  }

  /**
   * End tracking an operation
   */
  end(operationId: string, success: boolean = true, error?: string): void {
    const metric = this.activeOperations.get(operationId);

    if (!metric) {
      console.warn(`⚠️  Performance metric not found: ${operationId}`);
      return;
    }

    metric.endTime = Date.now();
    metric.durationMs = metric.endTime - metric.startTime;
    metric.success = success;
    metric.error = error;

    // Add to metrics array
    this.metrics.push(metric);

    // Clean up
    this.activeOperations.delete(operationId);

    // Trim metrics if too large
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics = this.metrics.slice(-this.MAX_METRICS);
    }

    // Log slow operations
    if (metric.durationMs > 1000) {
      console.warn(`⚠️  Slow operation detected: ${metric.operation} took ${metric.durationMs}ms`);
    }
  }

  /**
   * Get statistics for an operation
   */
  getStats(operation?: string): PerformanceStats[] {
    const filteredMetrics = operation
      ? this.metrics.filter(m => m.operation === operation && m.durationMs !== undefined)
      : this.metrics.filter(m => m.durationMs !== undefined);

    if (filteredMetrics.length === 0) {
      return [];
    }

    // Group by operation
    const grouped = new Map<string, PerformanceMetric[]>();
    for (const metric of filteredMetrics) {
      const key = metric.operation;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(metric);
    }

    // Calculate stats for each operation
    const stats: PerformanceStats[] = [];
    for (const [op, metrics] of grouped.entries()) {
      const durations = metrics.map(m => m.durationMs!);
      const totalDuration = durations.reduce((sum, d) => sum + d, 0);
      const successCount = metrics.filter(m => m.success).length;
      const failureCount = metrics.filter(m => !m.success).length;

      stats.push({
        operation: op,
        count: metrics.length,
        totalDurationMs: totalDuration,
        averageDurationMs: totalDuration / metrics.length,
        minDurationMs: Math.min(...durations),
        maxDurationMs: Math.max(...durations),
        successCount,
        failureCount,
      });
    }

    return stats;
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  /**
   * Get recent metrics
   */
  getRecentMetrics(count: number = 100): PerformanceMetric[] {
    return this.metrics.slice(-count);
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = [];
    this.activeOperations.clear();
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalOperations: number;
    operationTypes: number;
    averageDurationMs: number;
    successRate: number;
    activeOperations: number;
  } {
    const completed = this.metrics.filter(m => m.durationMs !== undefined);
    const totalDuration = completed.reduce((sum, m) => sum + (m.durationMs || 0), 0);
    const successCount = completed.filter(m => m.success).length;

    const operationTypes = new Set(this.metrics.map(m => m.operation)).size;

    return {
      totalOperations: completed.length,
      operationTypes,
      averageDurationMs: completed.length > 0 ? totalDuration / completed.length : 0,
      successRate: completed.length > 0 ? successCount / completed.length : 0,
      activeOperations: this.activeOperations.size,
    };
  }

  /**
   * Log performance stats to console
   */
  logStats(operation?: string): void {
    const stats = this.getStats(operation);

    if (stats.length === 0) {
      console.log('📊 No performance data available');
      return;
    }

    console.log('\n📊 Performance Statistics');
    console.log('='.repeat(80));

    for (const stat of stats) {
      console.log(`\n🔧 ${stat.operation}`);
      console.log(`   Count: ${stat.count}`);
      console.log(`   Average: ${stat.averageDurationMs.toFixed(2)}ms`);
      console.log(`   Min: ${stat.minDurationMs}ms`);
      console.log(`   Max: ${stat.maxDurationMs}ms`);
      console.log(`   Success Rate: ${((stat.successCount / stat.count) * 100).toFixed(1)}%`);
    }

    console.log('\n' + '='.repeat(80));
  }
}

// Singleton instance
export const performanceLogger = new PerformanceLogger();

/**
 * Helper function for async operations
 */
export async function trackPerformance<T>(
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T> {
  const operationId = performanceLogger.start(operation, metadata);

  try {
    const result = await fn();
    performanceLogger.end(operationId, true);
    return result;
  } catch (error) {
    performanceLogger.end(operationId, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
