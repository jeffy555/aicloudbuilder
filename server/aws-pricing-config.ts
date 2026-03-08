/**
 * AWS Pricing Configuration
 *
 * Deterministic pricing lookup table for AWS resources.
 * Mirrors the AZURE_PRICING_CONFIG architecture — each entry describes how to
 * build an AWS Price List API query and calculate a monthly cost estimate.
 *
 * API used: AWS Price List Bulk Index (public, no auth required)
 * Base URL: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{SERVICE}/current/{region}/index.json
 *
 * Last validated: 2026-03-05
 */

import { HOURS_PER_MONTH } from './config/constants.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface AwsPricingEntry {
  /** AWS service code used in the Price List API path, e.g. 'AmazonEC2' */
  serviceCode: string;
  /** HCL attribute keys whose values drive the pricing query */
  attributeKeys: string[];
  /** Default attribute values when Terraform doesn't specify them */
  defaults: Record<string, string>;
  /** Usage assumptions for monthly cost calculation */
  usageAssumptions: { hoursPerMonth?: number; gbPerMonth?: number };
  /** Build attribute filter for AWS Price List API (product attributes) */
  buildFilter: (attrs: Record<string, any>, region: string) => Record<string, string>;
  /** Select the best product from filtered results */
  selectItem: (products: any[], attrs: Record<string, any>) => any;
  /** Calculate monthly cost from a selected product */
  calculateCost: (product: any, attrs: Record<string, any>) => number;
}

// ─── Cost helpers ──────────────────────────────────────────────────────────────

function perHourAws(product: any): number {
  const price = extractUsdPrice(product);
  return (price || 0) * HOURS_PER_MONTH;
}

function perGbMonthAws(product: any, gb: number): number {
  const price = extractUsdPrice(product);
  return (price || 0) * gb;
}

/** Extract USD price from AWS Price List product's terms/priceDimensions structure */
function extractUsdPrice(product: any): number {
  if (!product) return 0;
  // Direct retailPrice (when pre-extracted)
  if (typeof product.retailPrice === 'number') return product.retailPrice;
  // AWS Price List structure: terms.OnDemand[offerId].priceDimensions[pdId].pricePerUnit.USD
  try {
    const onDemand = product.terms?.OnDemand;
    if (!onDemand) return 0;
    const offerKey = Object.keys(onDemand)[0];
    const priceDimensions = onDemand[offerKey]?.priceDimensions;
    const pdKey = Object.keys(priceDimensions || {})[0];
    const usd = priceDimensions?.[pdKey]?.pricePerUnit?.USD;
    return usd ? parseFloat(usd) : 0;
  } catch {
    return 0;
  }
}

// ─── AWS Region mapping ────────────────────────────────────────────────────────

/**
 * Terraform AWS region → AWS Price List region name.
 * The Price List API uses human-readable region names, not the API identifiers.
 */
export const AWS_REGION_MAP: Record<string, string> = {
  'us-east-1':      'US East (N. Virginia)',
  'us-east-2':      'US East (Ohio)',
  'us-west-1':      'US West (N. California)',
  'us-west-2':      'US West (Oregon)',
  'ca-central-1':   'Canada (Central)',
  'eu-west-1':      'Europe (Ireland)',
  'eu-west-2':      'Europe (London)',
  'eu-west-3':      'Europe (Paris)',
  'eu-central-1':   'Europe (Frankfurt)',
  'eu-north-1':     'Europe (Stockholm)',
  'eu-south-1':     'Europe (Milan)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-south-1':     'Asia Pacific (Mumbai)',
  'ap-east-1':      'Asia Pacific (Hong Kong)',
  'sa-east-1':      'South America (Sao Paulo)',
  'me-south-1':     'Middle East (Bahrain)',
  'af-south-1':     'Africa (Cape Town)',
};

export function resolveAwsRegion(terraformRegion: string): string {
  return AWS_REGION_MAP[terraformRegion] || 'US East (N. Virginia)';
}

// ─── Free AWS Resources ────────────────────────────────────────────────────────

/**
 * AWS resources that have no direct hourly/monthly charge.
 * The message explains what IS charged (so users understand the context).
 */
export const FREE_AWS_RESOURCES: Record<string, string> = {
  'aws_vpc':                           'VPC is free; charges apply to NAT Gateway, VPN, Transit Gateway',
  'aws_subnet':                        'Subnets are free',
  'aws_security_group':                'Security groups are free',
  'aws_security_group_rule':           'Security group rules are free',
  'aws_iam_role':                      'IAM roles are free',
  'aws_iam_policy':                    'IAM policies are free',
  'aws_iam_role_policy_attachment':    'IAM role policy attachments are free',
  'aws_iam_instance_profile':          'IAM instance profiles are free',
  'aws_route_table':                   'Route tables are free',
  'aws_route':                         'Routes are free',
  'aws_route_table_association':       'Route table associations are free',
  'aws_internet_gateway':              'Internet gateways are free (data transfer is charged)',
  'aws_key_pair':                      'Key pairs are free',
  'aws_cloudwatch_log_group':          'Log groups are free (ingestion/storage is charged)',
  'aws_s3_bucket_policy':              'Bucket policies are free',
  'aws_s3_bucket_versioning':          'Versioning config is free (storage is charged)',
  'aws_s3_bucket_server_side_encryption_configuration': 'SSE config is free (KMS key usage may be charged)',
  'aws_s3_bucket_public_access_block': 'Public access block config is free',
  'aws_ecr_lifecycle_policy':          'ECR lifecycle policies are free',
  'aws_sns_topic_subscription':        'SNS subscriptions are free (delivery charges apply)',
  'aws_sqs_queue_policy':              'SQS queue policies are free',
  'aws_lambda_permission':             'Lambda permissions are free',
  'aws_cloudwatch_event_rule':         'CloudWatch Event rules are free',
  'aws_cloudwatch_event_target':       'CloudWatch Event targets are free',
  'aws_acm_certificate':               'ACM public certificates are free',
  'aws_acm_certificate_validation':    'ACM validation is free',
};

// ─── AWS Pricing Config ────────────────────────────────────────────────────────

export const AWS_PRICING_CONFIG: Record<string, AwsPricingEntry> = {

  // ═══ COMPUTE ═══

  'aws_instance': {
    serviceCode: 'AmazonEC2',
    attributeKeys: ['instance_type', 'ami'],
    defaults: { instance_type: 't3.micro' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, region) => ({
      instanceType:  attrs.instance_type || 't3.micro',
      operatingSystem: attrs.ami?.toLowerCase().includes('windows') ? 'Windows' : 'Linux',
      tenancy:       'Shared',
      capacitystatus: 'Used',
      preInstalledSw: 'NA',
      location:      resolveAwsRegion(region),
    }),
    selectItem: (products) =>
      products.find(p => p.attributes?.operatingSystem === 'Linux') || products[0] || null,
    calculateCost: (product) => perHourAws(product),
  },

  'aws_spot_instance_request': {
    serviceCode: 'AmazonEC2',
    attributeKeys: ['instance_type'],
    defaults: { instance_type: 't3.micro' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, region) => ({
      instanceType: attrs.instance_type || 't3.micro',
      location:     resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product) => perHourAws(product) * 0.3, // Spot is ~70% cheaper than On-Demand
  },

  // ═══ DATABASE ═══

  'aws_db_instance': {
    serviceCode: 'AmazonRDS',
    attributeKeys: ['instance_class', 'engine', 'multi_az'],
    defaults: { instance_class: 'db.t3.micro', engine: 'mysql' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, region) => ({
      instanceType: attrs.instance_class || 'db.t3.micro',
      databaseEngine: attrs.engine?.toLowerCase().includes('postgres') ? 'PostgreSQL'
                    : attrs.engine?.toLowerCase().includes('mariadb') ? 'MariaDB'
                    : attrs.engine?.toLowerCase().includes('oracle') ? 'Oracle'
                    : 'MySQL',
      deploymentOption: attrs.multi_az === true ? 'Multi-AZ' : 'Single-AZ',
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product) => perHourAws(product),
  },

  'aws_rds_cluster': {
    serviceCode: 'AmazonRDS',
    attributeKeys: ['engine', 'engine_mode'],
    defaults: { engine: 'aurora-mysql' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, region) => ({
      databaseEngine: attrs.engine?.includes('postgres') ? 'Aurora PostgreSQL' : 'Aurora MySQL',
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product) => perHourAws(product),
  },

  'aws_elasticache_cluster': {
    serviceCode: 'AmazonElastiCache',
    attributeKeys: ['node_type', 'engine'],
    defaults: { node_type: 'cache.t3.micro', engine: 'redis' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, region) => ({
      instanceType: attrs.node_type || 'cache.t3.micro',
      location:     resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product) => perHourAws(product),
  },

  'aws_elasticache_replication_group': {
    serviceCode: 'AmazonElastiCache',
    attributeKeys: ['node_type', 'num_cache_clusters'],
    defaults: { node_type: 'cache.t3.micro', num_cache_clusters: '1' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, region) => ({
      instanceType: attrs.node_type || 'cache.t3.micro',
      location:     resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product, attrs) => {
      const nodeCount = parseInt(attrs.num_cache_clusters || '1', 10) || 1;
      return perHourAws(product) * nodeCount;
    },
  },

  'aws_dynamodb_table': {
    serviceCode: 'AmazonDynamoDB',
    attributeKeys: ['billing_mode', 'read_capacity', 'write_capacity'],
    defaults: { billing_mode: 'PROVISIONED', read_capacity: '5', write_capacity: '5' },
    usageAssumptions: {},
    buildFilter: (_attrs, region) => ({
      group:    'Amazon DynamoDB PayPerRequest Throughput',
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (_product, attrs) => {
      // Provisioned: RCU × $0.00013/hr + WCU × $0.00065/hr (approximate us-east-1)
      const rcu = parseInt(attrs.read_capacity || '5', 10);
      const wcu = parseInt(attrs.write_capacity || '5', 10);
      return (rcu * 0.00013 + wcu * 0.00065) * HOURS_PER_MONTH;
    },
  },

  // ═══ STORAGE ═══

  'aws_s3_bucket': {
    serviceCode: 'AmazonS3',
    attributeKeys: ['bucket', 'bucket_prefix'],
    defaults: {},
    usageAssumptions: { gbPerMonth: 100 },
    buildFilter: (_attrs, region) => ({
      storageClass: 'General Purpose',
      volumeType:   'Standard',
      location:     resolveAwsRegion(region),
    }),
    selectItem: (products) => products.find(p =>
      p.attributes?.storageClass === 'General Purpose'
    ) || products[0] || null,
    calculateCost: (product) => perGbMonthAws(product, 100), // assume 100 GB
  },

  'aws_ebs_volume': {
    serviceCode: 'AmazonEC2',
    attributeKeys: ['type', 'size'],
    defaults: { type: 'gp3', size: '20' },
    usageAssumptions: {},
    buildFilter: (attrs, region) => ({
      volumeApiName: attrs.type || 'gp3',
      location:      resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product, attrs) => {
      const sizeGb = parseInt(attrs.size || '20', 10);
      return perGbMonthAws(product, sizeGb);
    },
  },

  'aws_efs_file_system': {
    serviceCode: 'AmazonEFS',
    attributeKeys: ['throughput_mode', 'performance_mode'],
    defaults: { throughput_mode: 'bursting' },
    usageAssumptions: { gbPerMonth: 100 },
    buildFilter: (_attrs, region) => ({
      storageClass: 'General Purpose',
      location:     resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product) => perGbMonthAws(product, 100),
  },

  // ═══ COMPUTE — SERVERLESS / CONTAINERS ═══

  'aws_lambda_function': {
    serviceCode: 'AWSLambda',
    attributeKeys: ['memory_size', 'runtime'],
    defaults: { memory_size: '128' },
    usageAssumptions: {},
    buildFilter: (_attrs, region) => ({
      group:    'AWS-Lambda-Duration',
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (_product, attrs) => {
      // Rough estimate: 1M invocations × 200ms × memory GB-seconds
      const memMb = parseInt(attrs.memory_size || '128', 10);
      const gbSec = (memMb / 1024) * 0.2 * 1_000_000; // 1M invocations at 200ms
      return gbSec * 0.0000166667; // $0.0000166667 per GB-second
    },
  },

  'aws_ecs_service': {
    serviceCode: 'AmazonECS',
    attributeKeys: ['launch_type', 'desired_count'],
    defaults: { launch_type: 'FARGATE', desired_count: '1' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, region) => ({
      fargateComputeType: attrs.launch_type === 'FARGATE' ? 'CPU' : undefined,
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (_product, attrs) => {
      // Fargate: 0.25 vCPU × $0.04048/vCPU-hr × 730hr × desired_count
      const count = parseInt(attrs.desired_count || '1', 10);
      return 0.25 * 0.04048 * HOURS_PER_MONTH * count;
    },
  },

  'aws_eks_cluster': {
    serviceCode: 'AmazonEKS',
    attributeKeys: ['name'],
    defaults: {},
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (_attrs, region) => ({
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: () => 0.10 * HOURS_PER_MONTH, // $0.10/hr cluster management fee
  },

  'aws_ecr_repository': {
    serviceCode: 'AmazonECR',
    attributeKeys: ['image_tag_mutability'],
    defaults: {},
    usageAssumptions: { gbPerMonth: 5 },
    buildFilter: (_attrs, region) => ({
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: () => 5 * 0.10, // 5 GB × $0.10/GB-month
  },

  // ═══ NETWORKING ═══

  'aws_lb': {
    serviceCode: 'AmazonEC2',
    attributeKeys: ['load_balancer_type', 'internal'],
    defaults: { load_balancer_type: 'application' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (attrs, region) => ({
      group:    attrs.load_balancer_type === 'network' ? 'Load Balancer-Network' : 'Load Balancer-Application',
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product) => perHourAws(product),
  },

  'aws_alb': {
    serviceCode: 'AmazonEC2',
    attributeKeys: ['load_balancer_type'],
    defaults: { load_balancer_type: 'application' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (_attrs, region) => ({
      group:    'Load Balancer-Application',
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product) => perHourAws(product),
  },

  'aws_nat_gateway': {
    serviceCode: 'AmazonEC2',
    attributeKeys: ['subnet_id'],
    defaults: {},
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (_attrs, region) => ({
      group:    'NAT Gateway',
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product) => perHourAws(product),
  },

  'aws_cloudfront_distribution': {
    serviceCode: 'AmazonCloudFront',
    attributeKeys: ['price_class'],
    defaults: { price_class: 'PriceClass_100' },
    usageAssumptions: {},
    buildFilter: (_attrs, _region) => ({
      location: 'United States',
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: () => 1000 * 0.0085, // 1TB data transfer × $0.0085/GB (PriceClass_100 US)
  },

  // ═══ MESSAGING ═══

  'aws_sqs_queue': {
    serviceCode: 'AmazonSQS',
    attributeKeys: ['fifo_queue'],
    defaults: { fifo_queue: 'false' },
    usageAssumptions: {},
    buildFilter: (_attrs, region) => ({
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (_product, attrs) => {
      // 1M requests/month × $0.40 per million (standard) or $0.50 (FIFO)
      const ratePerM = attrs.fifo_queue === 'true' ? 0.50 : 0.40;
      return ratePerM; // 1M requests assumed
    },
  },

  'aws_sns_topic': {
    serviceCode: 'AmazonSNS',
    attributeKeys: ['name'],
    defaults: {},
    usageAssumptions: {},
    buildFilter: (_attrs, region) => ({
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: () => 0.50, // $0.50 per 1M publishes assumed
  },

  'aws_kinesis_stream': {
    serviceCode: 'AmazonKinesis',
    attributeKeys: ['shard_count'],
    defaults: { shard_count: '1' },
    usageAssumptions: { hoursPerMonth: HOURS_PER_MONTH },
    buildFilter: (_attrs, region) => ({
      group:    'Kinesis Streams ShardHour',
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: (product, attrs) => {
      const shards = parseInt(attrs.shard_count || '1', 10);
      return perHourAws(product) * shards;
    },
  },

  // ═══ SECURITY / OBSERVABILITY ═══

  'aws_kms_key': {
    serviceCode: 'awskms',
    attributeKeys: ['key_usage'],
    defaults: {},
    usageAssumptions: {},
    buildFilter: (_attrs, region) => ({
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: () => 1.00, // $1/month per CMK
  },

  'aws_secretsmanager_secret': {
    serviceCode: 'AWSSecretsManager',
    attributeKeys: ['name'],
    defaults: {},
    usageAssumptions: {},
    buildFilter: (_attrs, region) => ({
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: () => 0.40, // $0.40/secret/month
  },

  'aws_wafv2_web_acl': {
    serviceCode: 'AWSWAF',
    attributeKeys: ['scope'],
    defaults: { scope: 'REGIONAL' },
    usageAssumptions: {},
    buildFilter: (_attrs, region) => ({
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: () => 5.00 + 1.00, // $5/month WebACL + $1/rule (assume 1 rule)
  },

  'aws_route53_zone': {
    serviceCode: 'AmazonRoute53',
    attributeKeys: ['name', 'private_zone'],
    defaults: { private_zone: 'false' },
    usageAssumptions: {},
    buildFilter: (_attrs, region) => ({
      location: resolveAwsRegion(region),
    }),
    selectItem: (products) => products[0] || null,
    calculateCost: () => 0.50, // $0.50/hosted zone/month
  },
};

// ─── Helper functions ──────────────────────────────────────────────────────────

export function getAwsPricingConfig(resourceType: string): AwsPricingEntry | null {
  return AWS_PRICING_CONFIG[resourceType] ?? null;
}

export function isFreeAwsResource(resourceType: string): string | null {
  return FREE_AWS_RESOURCES[resourceType] ?? null;
}

export function calculateAwsMonthlyCost(
  resourceType: string,
  product: any,
  attrs: Record<string, any>
): number | null {
  const config = AWS_PRICING_CONFIG[resourceType];
  if (!config) return 0;
  if (!product && Object.keys(attrs).length === 0) return 0;

  const mergedAttrs = { ...config.defaults, ...attrs };
  return config.calculateCost(product, mergedAttrs);
}
