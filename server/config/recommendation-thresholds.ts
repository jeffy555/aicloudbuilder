/**
 * @deprecated This file is no longer used. All recommendation logic has been
 * moved to AI-driven analysis. Retained for reference only — safe to delete.
 */

/**
 * Thresholds and savings estimates for the cost-optimization recommendation engine.
 *
 * Design principles:
 *   - Every threshold is named, not a bare literal.
 *   - Each entry documents the assumption behind the number.
 *   - Savings percentages are conservative estimates based on publicly available
 *     Azure pricing comparisons. Adjust per real-world observation.
 *   - Thresholds for "underutilised" are intentionally conservative to avoid
 *     false-positive resize recommendations.
 *
 * Last validated: 2026-03-05
 */

// ---------------------------------------------------------------------------
// Minimum sample count required before a metrics-based recommendation
// is considered statistically valid.
// 100 samples ≈ 4 days of hourly data — enough to observe weekly patterns.
// ---------------------------------------------------------------------------
export const MIN_METRICS_SAMPLE_COUNT = 100;

// ---------------------------------------------------------------------------
// Virtual Machine utilisation thresholds
// ---------------------------------------------------------------------------

/**
 * HIGH-confidence VM downsizing:
 * VM is significantly over-provisioned when BOTH metrics are below these
 * values for the entire observation window.
 * Source: Azure Advisor recommendation logic (public documentation).
 */
export const VM_CPU_LOW_THRESHOLD    = 20;  // % average CPU
export const VM_MEMORY_LOW_THRESHOLD = 30;  // % average memory

/**
 * MEDIUM-confidence B-series migration:
 * Low baseline with occasional spikes — burstable tier fits the workload.
 */
export const VM_CPU_BURSTABLE_AVG_THRESHOLD = 30;   // % average CPU
export const VM_CPU_BURSTABLE_MAX_THRESHOLD = 70;   // % peak CPU

// ---------------------------------------------------------------------------
// SQL Database (DTU model) utilisation threshold
// ---------------------------------------------------------------------------

/**
 * Recommend a lower DTU tier when average DTU consumption is below this level.
 * Source: Microsoft's Azure SQL performance tuning guidance.
 */
export const SQL_DTU_LOW_THRESHOLD = 25;  // % average DTU

// ---------------------------------------------------------------------------
// App Service Plan utilisation thresholds
// ---------------------------------------------------------------------------

export const APP_SERVICE_CPU_LOW_THRESHOLD    = 30;  // % average CPU
export const APP_SERVICE_MEMORY_LOW_THRESHOLD = 40;  // % average memory

// ---------------------------------------------------------------------------
// Storage Account cool-tier recommendation
// ---------------------------------------------------------------------------

/**
 * Recommend switching from Hot to Cool access tier when actual storage usage
 * is below this volume. Very small datasets accessed infrequently cost more
 * in access fees on Cool tier, so we use a GB floor.
 */
export const STORAGE_COOL_TIER_THRESHOLD_GB = 50;  // GB of used capacity

// ---------------------------------------------------------------------------
// Savings percentage estimates
// All values are conservative estimates based on Azure public pricing data.
// Actual savings vary by region, contract type, and negotiated discounts.
// ---------------------------------------------------------------------------

export const SAVINGS_ESTIMATES = {
  // VM: downsize to next-smaller instance (e.g., D8 → D4)
  VM_DOWNSIZE:              0.50,  // ~50 % cost reduction
  // VM: migrate from D/E-series to burstable B-series
  VM_TO_BURSTABLE:          0.60,  // ~60 % cost reduction
  // SQL: downgrade from Premium to Standard tier
  SQL_PREMIUM_TO_STANDARD:  0.40,  // ~40 % cost reduction
  // SQL: downgrade from Business Critical to General Purpose
  SQL_BC_TO_GP:             0.50,  // ~50 % cost reduction
  // App Service Plan: downgrade SKU (e.g., P1 → S1)
  APP_SERVICE_DOWNGRADE:    0.35,  // ~35 % cost reduction
  // Storage: switch access tier from Hot to Cool
  STORAGE_HOT_TO_COOL:      0.30,  // ~30 % cost reduction
  // Storage: change replication from Premium to Standard
  STORAGE_PREMIUM_TO_STD:   0.60,  // ~60 % cost reduction
  // Storage: change replication from GRS/RA-GRS to LRS
  STORAGE_GRS_TO_LRS:       0.50,  // ~50 % cost reduction
  // Redis: downgrade from Premium to Standard cluster
  REDIS_PREMIUM_TO_STD:     0.40,  // ~40 % cost reduction
  // App Service Plan: conservative rule-based downgrade
  APP_SERVICE_RULE_BASED:   0.30,  // ~30 % cost reduction (low confidence)
  // App Service Plan: Standard → Basic (dev/test only)
  APP_SERVICE_STD_TO_BASIC: 0.20,  // ~20 % cost reduction
  // VM: rule-based large-VM flag without metrics data
  VM_RULE_BASED_LARGE:      0.50,  // ~50 % cost reduction (low confidence)
  // VM: rule-based Standard → Burstable without metrics data
  VM_RULE_BASED_BURSTABLE:  0.65,  // ~65 % cost reduction (very low confidence)
} as const;

// ---------------------------------------------------------------------------
// SKU downgrade maps — single source of truth for size recommendations
// ---------------------------------------------------------------------------

/**
 * Recommended next-smaller VM size for common D/E-series instances.
 * Extend this map as new Azure VM generations are released.
 * Source: Azure VM size documentation (sizes within the same family).
 */
export const VM_DOWNSIZE_MAP: Record<string, string> = {
  'Standard_D64s_v3': 'Standard_D32s_v3',
  'Standard_D32s_v3': 'Standard_D16s_v3',
  'Standard_D16s_v3': 'Standard_D8s_v3',
  'Standard_D8s_v3':  'Standard_D4s_v3',
  'Standard_D4s_v3':  'Standard_D2s_v3',
  'Standard_D64s_v4': 'Standard_D32s_v4',
  'Standard_D32s_v4': 'Standard_D16s_v4',
  'Standard_D16s_v4': 'Standard_D8s_v4',
  'Standard_D8s_v4':  'Standard_D4s_v4',
  'Standard_D4s_v4':  'Standard_D2s_v4',
  'Standard_E16s_v3': 'Standard_E8s_v3',
  'Standard_E8s_v3':  'Standard_E4s_v3',
  'Standard_E4s_v3':  'Standard_E2s_v3',
  'Standard_D16':     'Standard_D8s_v3',
  'Standard_D32':     'Standard_D16s_v3',
  'Standard_D8':      'Standard_D4s_v3',
  'Standard_D4':      'Standard_D2s_v3',
};

/** Default recommendation when the exact VM size is not in the map above. */
export const VM_DOWNSIZE_FALLBACK = 'Standard_D2s_v3';

/** Recommended burstable instance for workloads with low baseline CPU. */
export const VM_BURSTABLE_RECOMMENDATION = 'Standard_B4ms';

/**
 * Recommended lower SQL DTU tier for each current tier.
 */
export const SQL_TIER_DOWNGRADE_MAP: Record<string, string> = {
  P3: 'S3',
  P2: 'S2',
  P1: 'S1',
  S3: 'S2',
  S2: 'S1',
};

/** Fallback SQL tier when current tier is not in the map. */
export const SQL_TIER_DOWNGRADE_FALLBACK = 'S1';

/**
 * Recommended lower App Service Plan SKU for each current SKU.
 */
export const APP_SERVICE_PLAN_DOWNGRADE_MAP: Record<string, string> = {
  P3v3: 'P2v3',
  P2v3: 'P1v3',
  P1v3: 'S1',
  P3v2: 'P1v2',
  P2v2: 'P1v2',
  P1v2: 'S1',
  S3:   'S2',
  S2:   'S1',
};

/** Fallback App Service Plan SKU. */
export const APP_SERVICE_PLAN_DOWNGRADE_FALLBACK = 'S1';
