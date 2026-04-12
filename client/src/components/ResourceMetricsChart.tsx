/**
 * Resource Metrics Chart Component
 *
 * Displays CPU/Memory/DTU usage trends from Azure Monitor using Recharts
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import type { UsageMetrics } from "@shared/schema";

interface ResourceMetricsChartProps {
  metrics: UsageMetrics;
  resourceName: string;
}

interface ChartDataPoint {
  timestamp: string;
  cpu?: number;
  memory?: number;
  dtu?: number;
  storage?: number;
}

/**
 * Transform Azure Monitor metrics into Recharts-compatible format
 */
function transformMetricsToChartData(metrics: UsageMetrics): ChartDataPoint[] {
  const dataMap = new Map<string, ChartDataPoint>();

  for (const metric of metrics.metrics) {
    const metricName = metric.name;
    const timeseries = metric.timeseries?.[0];

    if (!timeseries || !timeseries.data) continue;

    for (const dataPoint of timeseries.data) {
      const timestamp = dataPoint.timeStamp;
      const average = dataPoint.average;

      if (!average && average !== 0) continue;

      // Get or create data point for this timestamp
      if (!dataMap.has(timestamp)) {
        dataMap.set(timestamp, { timestamp });
      }
      const point = dataMap.get(timestamp)!;

      // Map metric names to chart fields
      if (metricName === 'Percentage CPU' || metricName === 'cpu_percent' || metricName === 'CpuPercentage') {
        point.cpu = average;
      } else if (metricName === 'MemoryPercentage' || metricName === 'memory_percent') {
        point.memory = average;
      } else if (metricName === 'MemoryWorkingSet') {
        // Convert bytes to percentage (assume 2GB max for web apps)
        point.memory = (average / (2 * 1024 * 1024 * 1024)) * 100;
      } else if (metricName === 'Available Memory Bytes') {
        // Convert available to used percentage using actual VM memory if available
        const avgAvailableGB = average / (1024 * 1024 * 1024);
        const maxMemoryGB = (metrics.statistics as any)?.maxMemoryGB || 100;
        point.memory = avgAvailableGB > 0 ? Math.min(100, 100 - (avgAvailableGB / maxMemoryGB) * 100) : 50;
      } else if (metricName === 'dtu_consumption_percent') {
        point.dtu = average;
      } else if (metricName === 'storage_percent') {
        point.storage = average;
      } else if (metricName === 'UsedCapacity') {
        point.storage = average / (1024 * 1024 * 1024); // Convert bytes to GB
      }
    }
  }

  // Convert map to array and sort by timestamp
  const chartData = Array.from(dataMap.values()).sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return chartData;
}

/**
 * Format timestamp for X-axis display
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:00`;
}

/**
 * Custom tooltip for displaying metric values
 */
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload || payload.length === 0) return null;

  const data = payload[0].payload;
  const fullDate = new Date(data.timestamp).toLocaleString();

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg p-3">
      <p className="text-xs text-muted-foreground mb-2">{fullDate}</p>
      {payload.map((entry: any) => (
        <div key={entry.name} className="flex items-center gap-2 text-sm">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="font-medium">{entry.name}:</span>
          <span>{entry.value.toFixed(1)}{entry.name === 'Storage (GB)' ? ' GB' : '%'}</span>
        </div>
      ))}
    </div>
  );
}

export default function ResourceMetricsChart({ metrics, resourceName }: ResourceMetricsChartProps) {
  const chartData = transformMetricsToChartData(metrics);
  const stats = metrics.statistics;

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage Metrics - {resourceName}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No metrics data available for this resource.</p>
        </CardContent>
      </Card>
    );
  }

  // Determine which metrics are available
  const hasCpu = chartData.some(d => d.cpu !== undefined);
  const hasMemory = chartData.some(d => d.memory !== undefined);
  const hasDtu = chartData.some(d => d.dtu !== undefined);
  const hasStorage = chartData.some(d => d.storage !== undefined);

  return (
    <Card className="border-2 border-blue-100 dark:border-blue-900 bg-gradient-to-br from-blue-50/50 to-white dark:from-blue-950/20 dark:to-background">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Usage Metrics - {resourceName}</CardTitle>
          <Badge variant="outline" className="text-xs">
            Last 7 days • {stats?.sampleCount || chartData.length} samples
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Line Chart */}
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={formatTimestamp}
              tick={{ fontSize: 11 }}
              stroke="#64748b"
            />
            <YAxis
              tick={{ fontSize: 11 }}
              stroke="#64748b"
              label={{ value: hasDtu ? 'DTU %' : hasStorage ? 'GB' : 'Usage %', angle: -90, position: 'insideLeft', fontSize: 11 }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: '12px' }}
              iconType="line"
            />
            {hasCpu && (
              <Line
                type="monotone"
                dataKey="cpu"
                stroke="#3b82f6"
                strokeWidth={2}
                name="CPU %"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
            {hasMemory && (
              <Line
                type="monotone"
                dataKey="memory"
                stroke="#10b981"
                strokeWidth={2}
                name="Memory %"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
            {hasDtu && (
              <Line
                type="monotone"
                dataKey="dtu"
                stroke="#f59e0b"
                strokeWidth={2}
                name="DTU %"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
            {hasStorage && (
              <Line
                type="monotone"
                dataKey="storage"
                stroke="#8b5cf6"
                strokeWidth={2}
                name="Storage (GB)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>

        {/* Statistics Summary */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {stats.avgCpuPercent !== undefined && (
              <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-2 border border-blue-200 dark:border-blue-800">
                <div className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">Avg CPU</div>
                <div className="text-lg font-bold text-blue-900 dark:text-blue-100">
                  {stats.avgCpuPercent.toFixed(1)}%
                </div>
              </div>
            )}
            {stats.maxCpuPercent !== undefined && (
              <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-2 border border-blue-200 dark:border-blue-800">
                <div className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">Max CPU</div>
                <div className="text-lg font-bold text-blue-900 dark:text-blue-100">
                  {stats.maxCpuPercent.toFixed(1)}%
                </div>
              </div>
            )}
            {stats.avgMemoryPercent !== undefined && (
              <div className="bg-green-50 dark:bg-green-950/30 rounded-lg p-2 border border-green-200 dark:border-green-800">
                <div className="text-xs text-green-700 dark:text-green-300 font-medium mb-1">Avg Memory</div>
                <div className="text-lg font-bold text-green-900 dark:text-green-100">
                  {stats.avgMemoryPercent.toFixed(1)}%
                </div>
              </div>
            )}
            {stats.avgDtuPercent !== undefined && (
              <div className="bg-amber-50 dark:bg-amber-950/30 rounded-lg p-2 border border-amber-200 dark:border-amber-800">
                <div className="text-xs text-amber-700 dark:text-amber-300 font-medium mb-1">Avg DTU</div>
                <div className="text-lg font-bold text-amber-900 dark:text-amber-100">
                  {stats.avgDtuPercent.toFixed(1)}%
                </div>
              </div>
            )}
            {stats.avgStorageUsedGB !== undefined && (
              <div className="bg-purple-50 dark:bg-purple-950/30 rounded-lg p-2 border border-purple-200 dark:border-purple-800">
                <div className="text-xs text-purple-700 dark:text-purple-300 font-medium mb-1">Avg Storage</div>
                <div className="text-lg font-bold text-purple-900 dark:text-purple-100">
                  {stats.avgStorageUsedGB.toFixed(1)} GB
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
