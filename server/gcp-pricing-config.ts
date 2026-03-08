/**
 * GCP Pricing Configuration
 *
 * Deterministic pricing lookup table for Google Cloud resources.
 * Mirrors the AZURE_PRICING_CONFIG architecture — each entry describes how to
 * calculate a monthly cost estimate from Terraform attributes.
 *
 * API used: Google Cloud Pricing Calculator pricelist JSON (public, no auth required)
 * URL: https://cloudpricingcalculator.appspot.com/static/data/pricelist.json
 *
 * Prices below are approximate us-central1 list prices as of 2026-03-05.
 * Per-unit prices are used as fallbacks when the API call fails.
 *
 * Last validated: 2026-03-05
 */

import { HOURS_PER_MONTH } from './config/constants.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface GcpPricingEntry {
  /** GCP service name for display purposes */
  serviceName: string;
  /** HCL attribute keys whose values drive the pricing query */
  attributeKeys: string[];
  /** Default attribute values when Terraform doesn't specify them */
  defaults: Record<string, string>;
  /** Usage assumptions for monthly cost calculation */
  usageAssumptions: { hoursPerMonth?: number; gbPerMonth?: number };
  /** Identifier for GCP pricelist lookup (SKU description prefix) */
  skuDescription?: string;
  /** Calculate monthly cost from attributes + optional fetched price per unit */
  calculateCost: (attrs: Record<string, any>, pricePerUnit?: number) => number;
}

// ─── GCP Region mapping ────────────────────────────────────────────────────────

/**
 * Terraform GCP region → GCP Pricing Calculator region identifier.
 */
export const GCP_REGION_MAP: Record<string, string> = {
  'us-central1':           'us-central1',
  'us-east1':              'us-east1',
  'us-east4':              'us-east4',
  'us-west1':              'us-west1',
  'us-west2':              'us-west2',
  'us-west3':              'us-west3',
  'us-west4':              'us-west4',
  'northamerica-northeast1': 'northamerica-northeast1',
  'southamerica-east1':    'southamerica-east1',
  'europe-west1':          'europe-west1',
  'europe-west2':          'europe-west2',
  'europe-west3':          'europe-west3',
  'europe-west4':          'europe-west4',
  'europe-west6':          'europe-west6',
  'europe-north1':         'europe-north1',
  'asia-east1':            'asia-east1',
  'asia-east2':            'asia-east2',
  'asia-northeast1':       'asia-northeast1',
  'asia-northeast2':       'asia-northeast2',
  'asia-northeast3':       'asia-northeast3',
  'asia-south1':           'asia-south1',
  'asia-southeast1':       'asia-southeast1',
  'asia-southeast2':       'asia-southeast2',
  'australia-southeast1':  'australia-southeast1',
};

export function resolveGcpRegion(terraformRegion: string): string {
  return GCP_REGION_MAP[terraformRegion] || 'us-central1';
}

// ─── GCP Machine type hourly rates ────────────────────────────────────────────

/**
 * Approximate hourly on-demand prices for common GCP machine types (us-central1).
 * Used when the live pricelist cannot be fetched.
 * Source: cloud.google.com/compute/vm-instance-pricing
 * Last validated: 2026-03-05
 */
const GCP_MACHINE_TYPE_HOURLY: Record<string, number> = {
  'f1-micro':          0.0076,
  'g1-small':          0.0257,
  'e2-micro':          0.0084,
  'e2-small':          0.0168,
  'e2-medium':         0.0335,
  'e2-standard-2':     0.0670,
  'e2-standard-4':     0.1340,
  'e2-standard-8':     0.2680,
  'e2-standard-16':    0.5360,
  'n1-standard-1':     0.0475,
  'n1-standard-2':     0.0950,
  'n1-standard-4':     0.1900,
  'n1-standard-8':     0.3800,
  'n1-standard-16':    0.7600,
  'n2-standard-2':     0.0971,
  'n2-standard-4':     0.1942,
  'n2-standard-8':     0.3885,
  'n2-standard-16':    0.7770,
  'n2d-standard-2':    0.0876,
  'c2-standard-4':     0.2088,
  'c2-standard-8':     0.4176,
  'c2-standard-16':    0.8352,
};

function vmHourlyCost(machineType: string): number {
  // Direct lookup
  if (GCP_MACHINE_TYPE_HOURLY[machineType]) return GCP_MACHINE_TYPE_HOURLY[machineType];
  // Parse custom machine type: n1-custom-4-16384 → find closest n1-standard
  const parts = machineType.split('-');
  const family = parts[0] + '-' + parts[1];
  const vcpus  = parseInt(parts[2] || '2', 10);
  // ~$0.048 per vCPU/hr for n1 (approximate)
  const vcpuRate = family.startsWith('c2') ? 0.052 : 0.048;
  return vcpuRate * vcpus;
}

// ─── Free GCP Resources ────────────────────────────────────────────────────────

export const FREE_GCP_RESOURCES: Record<string, string> = {
  'google_compute_network':               'VPC networks are free',
  'google_compute_subnetwork':            'Subnets are free',
  'google_compute_firewall':              'Firewall rules are free',
  'google_compute_route':                 'Routes are free',
  'google_project':                       'Projects are free (resource container)',
  'google_project_iam_binding':           'IAM bindings are free',
  'google_project_iam_member':            'IAM members are free',
  'google_project_iam_policy':            'IAM policies are free',
  'google_service_account':               'Service accounts are free',
  'google_service_account_iam_binding':   'Service account IAM bindings are free',
  'google_storage_bucket_iam_binding':    'Bucket IAM bindings are free',
  'google_storage_bucket_iam_member':     'Bucket IAM members are free',
  'google_container_registry':            'Container Registry host is free (storage is charged)',
  'google_compute_ssl_policy':            'SSL policies are free',
  'google_dns_record_set':                'DNS record sets are free (zone/query charges apply)',
};

// ─── GCP Pricing Config ────────────────────────────────────────────────────────

export const GCP_PRICING_CONFIG: Record<string, GcpPricingEntry> = {

  // ═══ COMPUTE ═══

  'google_compute_instance': {
    serviceName: 'Compute Engine',
    attributeKeys: ['machine_type', 'zone'],
    defaults: { machine_type: 'n1-standard-1' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    skuDescription: 'N1 Predefined Instance Core',
    calculateCost: (attrs) => {
      const machineType = attrs.machine_type || 'n1-standard-1';
      return vmHourlyCost(machineType) * HOURS_PER_MONTH;
    },
  },

  'google_compute_instance_template': {
    serviceName: 'Compute Engine',
    attributeKeys: ['machine_type'],
    defaults: { machine_type: 'n1-standard-1' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    calculateCost: (attrs) => {
      const machineType = attrs.machine_type || 'n1-standard-1';
      return vmHourlyCost(machineType) * HOURS_PER_MONTH;
    },
  },

  'google_compute_instance_group_manager': {
    serviceName: 'Compute Engine',
    attributeKeys: ['target_size'],
    defaults: { target_size: '1' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    calculateCost: (attrs) => {
      const count = parseInt(attrs.target_size || '1', 10);
      // Uses the instance template's machine_type — default to n1-standard-1
      return vmHourlyCost('n1-standard-1') * HOURS_PER_MONTH * count;
    },
  },

  // ═══ DATABASE ═══

  'google_sql_database_instance': {
    serviceName: 'Cloud SQL',
    attributeKeys: ['database_version', 'tier', 'settings'],
    defaults: { tier: 'db-f1-micro', database_version: 'MYSQL_8_0' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    skuDescription: 'Cloud SQL for MySQL',
    calculateCost: (attrs) => {
      const tier = attrs.tier || 'db-f1-micro';
      // Approximate hourly rates for Cloud SQL tiers
      const tierRates: Record<string, number> = {
        'db-f1-micro':    0.0150,
        'db-g1-small':    0.0500,
        'db-n1-standard-1': 0.1050,
        'db-n1-standard-2': 0.2100,
        'db-n1-standard-4': 0.4200,
        'db-n1-standard-8': 0.8400,
        'db-n1-highmem-2':  0.2520,
        'db-n1-highmem-4':  0.5040,
      };
      return (tierRates[tier] || 0.10) * HOURS_PER_MONTH;
    },
  },

  'google_spanner_instance': {
    serviceName: 'Cloud Spanner',
    attributeKeys: ['num_nodes', 'processing_units'],
    defaults: { num_nodes: '1' },
    usageAssumptions: {},
    skuDescription: 'Cloud Spanner Regional Processing Unit',
    calculateCost: (attrs) => {
      // $0.90/hour per node (regional), or $0.09/hour per 100 processing units
      if (attrs.processing_units) {
        const pu = parseInt(attrs.processing_units, 10);
        return (pu / 100) * 0.09 * HOURS_PER_MONTH;
      }
      const nodes = parseInt(attrs.num_nodes || '1', 10);
      return nodes * 0.90 * HOURS_PER_MONTH;
    },
  },

  'google_redis_instance': {
    serviceName: 'Memorystore for Redis',
    attributeKeys: ['memory_size_gb', 'tier'],
    defaults: { memory_size_gb: '1', tier: 'BASIC' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    calculateCost: (attrs) => {
      const memGb = parseInt(attrs.memory_size_gb || '1', 10);
      // Basic: $0.049/GB-hr, Standard (HA): $0.065/GB-hr
      const ratePerGbHr = attrs.tier === 'STANDARD_HA' ? 0.065 : 0.049;
      return ratePerGbHr * memGb * HOURS_PER_MONTH;
    },
  },

  // ═══ STORAGE ═══

  'google_storage_bucket': {
    serviceName: 'Cloud Storage',
    attributeKeys: ['storage_class', 'location'],
    defaults: { storage_class: 'STANDARD' },
    usageAssumptions: { gbPerMonth: 100 },
    skuDescription: 'Standard Storage',
    calculateCost: (attrs) => {
      const storageClass = (attrs.storage_class || 'STANDARD').toUpperCase();
      // Per-GB-month rates (us-central1 approx.)
      const rates: Record<string, number> = {
        'STANDARD':         0.020,
        'NEARLINE':         0.010,
        'COLDLINE':         0.004,
        'ARCHIVE':          0.0012,
        'MULTI_REGIONAL':   0.026,
        'REGIONAL':         0.020,
      };
      return (rates[storageClass] || 0.020) * 100; // assume 100 GB
    },
  },

  'google_compute_disk': {
    serviceName: 'Compute Engine',
    attributeKeys: ['type', 'size'],
    defaults: { type: 'pd-standard', size: '100' },
    usageAssumptions: {},
    calculateCost: (attrs) => {
      const diskType = attrs.type || 'pd-standard';
      const sizeGb   = parseInt(attrs.size || '100', 10);
      // Per-GB-month rates
      const rates: Record<string, number> = {
        'pd-standard':    0.040,
        'pd-balanced':    0.100,
        'pd-ssd':         0.170,
        'pd-extreme':     0.170,
        'hyperdisk-balanced': 0.120,
      };
      return (rates[diskType] || 0.040) * sizeGb;
    },
  },

  // ═══ KUBERNETES ═══

  'google_container_cluster': {
    serviceName: 'Google Kubernetes Engine',
    attributeKeys: ['node_count', 'location'],
    defaults: { node_count: '3' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    calculateCost: () => 0.10 * HOURS_PER_MONTH, // $0.10/hour cluster management fee
  },

  'google_container_node_pool': {
    serviceName: 'Google Kubernetes Engine',
    attributeKeys: ['node_count', 'node_config'],
    defaults: { node_count: '3' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    calculateCost: (attrs) => {
      const count       = parseInt(attrs.node_count || '3', 10);
      const machineType = attrs.machine_type || 'n1-standard-1';
      return vmHourlyCost(machineType) * HOURS_PER_MONTH * count;
    },
  },

  // ═══ SERVERLESS ═══

  'google_cloudfunctions_function': {
    serviceName: 'Cloud Functions',
    attributeKeys: ['available_memory_mb', 'runtime'],
    defaults: { available_memory_mb: '256' },
    usageAssumptions: {},
    calculateCost: (attrs) => {
      const memMb = parseInt(attrs.available_memory_mb || '256', 10);
      // 2M invocations × 200ms × memory GB-seconds
      const gbSec = (memMb / 1024) * 0.2 * 2_000_000;
      return gbSec * 0.0000025; // $0.0000025/GB-second
    },
  },

  'google_cloudfunctions2_function': {
    serviceName: 'Cloud Functions (2nd gen)',
    attributeKeys: ['build_config', 'service_config'],
    defaults: {},
    usageAssumptions: {},
    calculateCost: () => 0.40, // approximate: 2M invocations/month
  },

  'google_cloud_run_service': {
    serviceName: 'Cloud Run',
    attributeKeys: ['template'],
    defaults: {},
    usageAssumptions: {},
    calculateCost: () => 1.00, // approximate: 1M requests/month + 1 vCPU-second
  },

  // ═══ ANALYTICS ═══

  'google_bigquery_dataset': {
    serviceName: 'BigQuery',
    attributeKeys: ['dataset_id', 'location'],
    defaults: {},
    usageAssumptions: {},
    calculateCost: () => 0.020 * 100, // $0.020/GB storage × 100 GB assumed
  },

  // ═══ MESSAGING ═══

  'google_pubsub_topic': {
    serviceName: 'Cloud Pub/Sub',
    attributeKeys: ['name'],
    defaults: {},
    usageAssumptions: {},
    calculateCost: () => 0.40, // $0.40 per 1M messages assumed
  },

  'google_pubsub_subscription': {
    serviceName: 'Cloud Pub/Sub',
    attributeKeys: ['name'],
    defaults: {},
    usageAssumptions: {},
    calculateCost: () => 0.40, // billed through topic
  },

  // ═══ NETWORKING ═══

  'google_compute_forwarding_rule': {
    serviceName: 'Cloud Load Balancing',
    attributeKeys: ['load_balancing_scheme'],
    defaults: { load_balancing_scheme: 'EXTERNAL' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    calculateCost: () => 0.025 * HOURS_PER_MONTH, // $0.025/hr per forwarding rule
  },

  'google_compute_global_forwarding_rule': {
    serviceName: 'Cloud Load Balancing',
    attributeKeys: [],
    defaults: {},
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    calculateCost: () => 0.025 * HOURS_PER_MONTH,
  },

  // ═══ SECURITY ═══

  'google_kms_crypto_key': {
    serviceName: 'Cloud KMS',
    attributeKeys: ['purpose', 'rotation_period'],
    defaults: { purpose: 'ENCRYPT_DECRYPT' },
    usageAssumptions: {},
    calculateCost: () => 0.06 + 0.03, // $0.06/key/month + $0.03/10K operations
  },

  // ═══ OBSERVABILITY ═══

  'google_dns_managed_zone': {
    serviceName: 'Cloud DNS',
    attributeKeys: ['dns_name', 'visibility'],
    defaults: { visibility: 'public' },
    usageAssumptions: {},
    calculateCost: () => 0.20, // $0.20/zone/month
  },

  'google_logging_metric': {
    serviceName: 'Cloud Logging',
    attributeKeys: ['name'],
    defaults: {},
    usageAssumptions: {},
    calculateCost: () => 0.50 * 50, // $0.50/GiB × 50 GiB assumed
  },
};

// ─── Helper functions ──────────────────────────────────────────────────────────

export function getGcpPricingConfig(resourceType: string): GcpPricingEntry | null {
  return GCP_PRICING_CONFIG[resourceType] ?? null;
}

export function isFreeGcpResource(resourceType: string): string | null {
  return FREE_GCP_RESOURCES[resourceType] ?? null;
}

export function calculateGcpMonthlyCost(
  resourceType: string,
  attrs: Record<string, any>,
  pricePerUnit?: number
): number | null {
  const config = GCP_PRICING_CONFIG[resourceType];
  if (!config) return 0;
  const mergedAttrs = { ...config.defaults, ...attrs };
  return config.calculateCost(mergedAttrs, pricePerUnit);
}
