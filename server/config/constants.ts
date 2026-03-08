/**
 * Central configuration constants for the Terraform module.
 *
 * Every magic number or tunable value lives here with:
 *   - The reason for the value
 *   - The source / industry reference (where applicable)
 *   - The last date it was validated
 *
 * Nothing in the business logic should embed a bare literal that
 * represents a threshold, limit, duration, or multiplier.
 */

// ---------------------------------------------------------------------------
// Pricing / Billing
// ---------------------------------------------------------------------------

/**
 * Azure bills compute resources hourly.
 * 730 = average hours in a calendar month (365 days / 12 months × 24 hours).
 * Source: Azure pricing documentation.
 * Last validated: 2026-03-05
 */
export const HOURS_PER_MONTH = 730;

/**
 * Environment traffic-load multipliers applied to usage-based cost estimates.
 * Compute resources (billed 24/7) are intentionally NOT multiplied.
 * Source: industry convention; adjust per organisation's actual usage ratios.
 * Last validated: 2026-03-05
 */
export const ENV_MULTIPLIERS: Record<string, number> = {
  dev:  0.1,   // 10 % of production traffic
  test: 0.3,   // 30 % of production traffic
  prod: 1.0,   // 100 % (baseline)
};

// ---------------------------------------------------------------------------
// Pricing confidence scoring
// All thresholds are on a [0, 1] scale.
// ---------------------------------------------------------------------------

/**
 * Pricing confidence boundaries used to classify a cost estimate as
 * high / medium / low quality.
 *
 * Values chosen to reflect:
 *   HIGH   (≥ 0.8) — exact SKU match from API, no variable substitution
 *   MEDIUM (≥ 0.5) — broad filter used or 1 variable unresolved
 *   LOW    (<  0.5) — multiple unknowns, defaults applied throughout
 */
export const CONFIDENCE_THRESHOLDS = {
  HIGH:                    0.8,
  MEDIUM:                  0.5,
  LOW:                     0.0,
  PENALTY_BROAD_FILTER:    0.4,  // deducted when a broad API filter was needed
  PENALTY_UNRESOLVED_VAR:  0.5,  // ceiling applied when vars remain unresolved
  PENALTY_DEFAULT_ATTRS:   0.6,  // ceiling applied when defaults were substituted
} as const;

// ---------------------------------------------------------------------------
// Azure Monitor metrics fetching
// ---------------------------------------------------------------------------

/**
 * Default look-back window for Azure Monitor queries.
 * PT168H = ISO 8601 for 7 days (168 hours).
 * Chosen because 7 days captures a full weekly load cycle.
 */
export const METRICS_DEFAULT_TIMESPAN = 'PT168H';

/**
 * Hourly granularity for metric data points (ISO 8601).
 * 1-hour intervals give 168 samples over 7 days —
 * enough for statistical significance without excessive data volume.
 */
export const METRICS_DEFAULT_INTERVAL = 'PT1H';

/**
 * Number of days covered by the default timespan (used for date arithmetic).
 */
export const METRICS_ANALYSIS_DAYS = 7;

/** Milliseconds in the default analysis period. */
export const METRICS_ANALYSIS_PERIOD_MS = METRICS_ANALYSIS_DAYS * 24 * 60 * 60 * 1000;

/**
 * Maximum concurrent Azure Monitor API requests per batch.
 * Azure Monitor allows ~60 requests/minute per subscription.
 * 5 concurrent with a 500 ms inter-batch delay ≈ 10 req/s, well within limits.
 */
export const METRICS_BATCH_SIZE = 5;

/** Milliseconds to wait between metric-fetch batches to respect rate limits. */
export const METRICS_BATCH_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Memory size assumptions for percentage conversion
// ---------------------------------------------------------------------------

/**
 * Assumed maximum RAM for an Azure Virtual Machine when only
 * "Available Memory Bytes" is returned (no total-memory metric).
 * Using 100 GB as a conservative upper bound for the D/E-series VMs
 * that are most commonly flagged for downsizing.
 */
export const VM_ASSUMED_MAX_MEMORY_GB = 100;

/**
 * Assumed maximum RAM for an Azure App Service (Web App).
 * The MemoryWorkingSet metric is in bytes; we convert it to a percentage
 * using this assumed maximum (2 GB is the upper limit for Standard S1).
 */
export const APP_SERVICE_ASSUMED_MAX_MEMORY_GB = 2;

// ---------------------------------------------------------------------------
// Byte unit helpers (no inline arithmetic in business logic)
// ---------------------------------------------------------------------------
export const BYTES_PER_KB = 1_024;
export const BYTES_PER_MB = 1_024 * BYTES_PER_KB;
export const BYTES_PER_GB = 1_024 * BYTES_PER_MB;

// ---------------------------------------------------------------------------
// Terraform version fallback
// ---------------------------------------------------------------------------

/**
 * Default Terraform version used when the MCP registry lookup fails.
 * Bump this when a new stable release becomes widely available.
 * Last validated: 2026-03-05
 */
export const TERRAFORM_DEFAULT_VERSION = '1.9.0';

// ---------------------------------------------------------------------------
// Refactor / validation thresholds
// ---------------------------------------------------------------------------

/**
 * Minimum character length for a hardcoded attribute value to be flagged
 * as "should be a variable". Values ≤ this length (e.g. "B1", "S1") are
 * short tier codes that are acceptable as literals.
 */
export const MIN_MEANINGFUL_VALUE_LENGTH = 3;

/**
 * Minimum character length for a Terraform resource name to be considered
 * "meaningful" when checking naming conventions.
 */
export const MIN_RESOURCE_NAME_LENGTH = 5;

/**
 * Maximum characters of a file or Mermaid diagram shown in debug log lines.
 */
export const DEBUG_PREVIEW_LENGTH = 200;

// ---------------------------------------------------------------------------
// Pricing cache
// ---------------------------------------------------------------------------

/** How long (ms) a pricing API response is cached before re-fetching. */
export const PRICING_CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour
