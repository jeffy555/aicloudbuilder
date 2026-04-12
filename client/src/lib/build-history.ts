import { apiRequest } from "./queryClient";

export interface BuildHistoryEntry {
  sessionId: string;
  module: string;
  buildId: string;
  status?: string;
  stages?: Array<{ name: string; status: string; completedAt?: string }>;
  pipelineStages?: string[];
  totalDurationMs?: number;
  filesGenerated?: number;
  repositoryName?: string;
  repositoryBranch?: string;
  metadata?: Record<string, any>;
}

/**
 * Generate a build ID with module prefix.
 * Format: MODULE-YYYYMMDD-HHmmss
 */
export function generateBuildId(module: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const prefix = module.toUpperCase().replace(/[^A-Z]/g, '').substring(0, 6);
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Save a build record to the server.
 * Call this from onPipelineComplete in any workflow.
 */
export async function saveBuildHistory(entry: BuildHistoryEntry): Promise<any> {
  try {
    const res = await apiRequest('POST', '/api/builds', {
      ...entry,
      status: entry.status || 'completed',
    });
    return res.json();
  } catch (error) {
    console.error('[BuildHistory] Failed to save build:', error);
    // Don't throw — build history is non-critical
    return null;
  }
}

/**
 * Fetch build history for a session or module.
 */
export async function fetchBuildHistory(params: {
  sessionId?: string;
  module?: string;
  limit?: number;
}): Promise<{ builds: any[]; total: number }> {
  try {
    const query = new URLSearchParams();
    if (params.sessionId) query.set('sessionId', params.sessionId);
    if (params.module) query.set('module', params.module);
    if (params.limit) query.set('limit', String(params.limit));
    const res = await apiRequest('GET', `/api/builds?${query.toString()}`);
    return res.json();
  } catch (error) {
    console.error('[BuildHistory] Failed to fetch builds:', error);
    return { builds: [], total: 0 };
  }
}
