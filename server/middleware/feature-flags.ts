/**
 * Feature Flag Middleware
 *
 * Phase 0: Controls gradual rollout of intelligent fix system features
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Feature flag configuration
 */
export const featureFlags = {
  // User-specific fix preferences
  userFixPreferences: process.env.ENABLE_USER_FIX_PREFERENCES === 'true',

  // Checkov native remediation fetching
  checkovNativeFetch: process.env.ENABLE_CHECKOV_NATIVE_FETCH === 'true',

  // Intelligent multi-tier fix retrieval
  intelligentFixRetrieval: process.env.ENABLE_INTELLIGENT_FIX_RETRIEVAL === 'true',

  // Performance logging
  performanceLogging: process.env.ENABLE_PERFORMANCE_LOGGING !== 'false', // Default true

  // Metrics dashboard
  metricsDashboard: process.env.ENABLE_METRICS_DASHBOARD !== 'false', // Default true

  // Kubernetes RAG remediation support
  kubernetesRAG: process.env.ENABLE_KUBERNETES_RAG === 'true',

  // Kubernetes AI-generated fix fallback
  kubernetesAIGeneration: process.env.ENABLE_K8S_AI_GEN === 'true',
} as const;

/**
 * Check if a feature flag is enabled
 */
export function isFeatureEnabled(flagName: keyof typeof featureFlags): boolean {
  return featureFlags[flagName];
}

/**
 * Middleware to require a specific feature flag
 */
export function requireFeatureFlag(flagName: keyof typeof featureFlags) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isFeatureEnabled(flagName)) {
      next();
    } else {
      res.status(403).json({
        error: 'Feature not enabled',
        feature: flagName,
        message: `This feature is currently disabled. Set ENABLE_${flagName.toUpperCase().replace(/([A-Z])/g, '_$1')} =true in .env to enable.`,
      });
    }
  };
}

/**
 * Middleware to check feature flags and set request context
 */
export function featureFlagMiddleware(req: Request, res: Response, next: NextFunction) {
  // Attach feature flags to request for easy access
  (req as any).features = featureFlags;
  next();
}

/**
 * GET endpoint to view current feature flag status
 */
export function getFeatureFlagStatus(req: Request, res: Response) {
  res.json({
    features: featureFlags,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Reload feature flags from environment (for testing)
 */
export function reloadFeatureFlags() {
  // Re-read environment variables
  (featureFlags as any).userFixPreferences = process.env.ENABLE_USER_FIX_PREFERENCES === 'true';
  (featureFlags as any).checkovNativeFetch = process.env.ENABLE_CHECKOV_NATIVE_FETCH === 'true';
  (featureFlags as any).intelligentFixRetrieval = process.env.ENABLE_INTELLIGENT_FIX_RETRIEVAL === 'true';
  (featureFlags as any).performanceLogging = process.env.ENABLE_PERFORMANCE_LOGGING !== 'false';
  (featureFlags as any).metricsDashboard = process.env.ENABLE_METRICS_DASHBOARD !== 'false';
  (featureFlags as any).kubernetesRAG = process.env.ENABLE_KUBERNETES_RAG === 'true';
  (featureFlags as any).kubernetesAIGeneration = process.env.ENABLE_K8S_AI_GEN === 'true';

  console.log('🔄 Feature flags reloaded:', featureFlags);
}

/**
 * Log feature flag status on server start
 */
export function logFeatureFlagStatus() {
  console.log('\n🚩 Feature Flags Status:');
  console.log('=' .repeat(60));
  console.log(`  User Fix Preferences:      ${featureFlags.userFixPreferences ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`  Checkov Native Fetch:      ${featureFlags.checkovNativeFetch ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`  Intelligent Fix Retrieval: ${featureFlags.intelligentFixRetrieval ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`  Performance Logging:       ${featureFlags.performanceLogging ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`  Metrics Dashboard:         ${featureFlags.metricsDashboard ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`  Kubernetes RAG:            ${featureFlags.kubernetesRAG ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`  Kubernetes AI Generation:  ${featureFlags.kubernetesAIGeneration ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log('=' .repeat(60) + '\n');
}
