import { z } from "zod";

// ── Shared sub-schemas ─────────────────────────────────────────────────────

const valuationResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  azureType: z.string(),
  terraformType: z.string().optional(),
  location: z.string(),
  resourceGroup: z.string(),
  currentSku: z.string(),
  currentTier: z.string().optional(),
  monthlyCost: z.number(),
  yearlyCost: z.number(),
  currency: z.string().default('INR'),
  remediation: z.object({
    recommended_sku: z.string(),
    recommended_tier: z.string().optional(),
    savings_monthly: z.number(),
    savings_percent: z.number(),
    reason: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    action_required: z.string(),
  }).optional(),
  pricingDetails: z.any().optional(),
  usageMetrics: z.any().optional(),
  metricsAvailable: z.boolean(),
}).passthrough();

const valuationSummarySchema = z.object({
  totalMonthlyCost: z.number(),
  totalYearlyCost: z.number(),
  potentialSavings: z.number(),
  savingsPercent: z.number(),
  resourceCount: z.number(),
  recommendationCount: z.number(),
});

const resourceGroupSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string(),
  resourceCount: z.number().optional(),
  tags: z.record(z.string()).optional(),
});

// ── POST /api/valuation/connect ────────────────────────────────────────────

export const valuationConnectBody = z.object({
  sessionId: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  tenantId: z.string().optional(),
  subscriptionId: z.string().optional(),
}).passthrough().openapi("ValuationConnectBody");

export const valuationConnectResponse = z.object({
  success: z.boolean(),
  subscriptionId: z.string().optional(),
  message: z.string().optional(),
}).openapi("ValuationConnectResponse");

// ── POST /api/valuation/resource-groups ────────────────────────────────────

export const resourceGroupsBody = z.object({
  sessionId: z.string().optional(),
}).passthrough().openapi("ResourceGroupsBody");

export const resourceGroupsResponse = z.object({
  success: z.boolean(),
  resourceGroups: z.array(resourceGroupSummarySchema),
}).openapi("ResourceGroupsResponse");

// ── POST /api/valuation/scan ───────────────────────────────────────────────

export const valuationScanBody = z.object({
  sessionId: z.string(),
  resourceGroupIds: z.array(z.string()).optional(),
}).passthrough().openapi("ValuationScanBody");

export const valuationScanResponse = z.object({
  success: z.boolean(),
  scannedCount: z.number(),
  resources: z.array(z.any()),
}).openapi("ValuationScanResponse");

// ── POST /api/valuation/analyze ────────────────────────────────────────────

const VALID_CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'KRW', 'BRL', 'MXN', 'SGD', 'HKD', 'NOK', 'SEK', 'DKK', 'NZD', 'ZAR', 'AED'] as const;

export const valuationAnalyzeBody = z.object({
  sessionId: z.string(),
  fetchMetrics: z.boolean().optional().default(true),
  currency: z.enum(VALID_CURRENCIES).optional().default('INR'),
}).passthrough().openapi("ValuationAnalyzeBody");

export const valuationAnalyzeResponse = z.object({
  success: z.boolean(),
  summary: valuationSummarySchema,
  resources: z.array(valuationResourceSchema),
}).openapi("ValuationAnalyzeResponse");

// ── POST /api/valuation/reserved-instances ─────────────────────────────────

export const reservedInstancesBody = z.object({
  resources: z.array(valuationResourceSchema),
}).passthrough().openapi("ReservedInstancesBody");

export const reservedInstancesResponse = z.object({
  recommendations: z.array(z.object({
    resourceName: z.string(),
    resourceType: z.string(),
    region: z.string(),
    currentSku: z.string(),
    onDemandMonthly: z.number(),
    reservedMonthly1Yr: z.number(),
    reservedMonthly3Yr: z.number(),
    saving1YrMonthly: z.number(),
    saving1YrAnnual: z.number(),
    saving1YrPercent: z.number(),
    saving3YrMonthly: z.number(),
    saving3YrAnnual: z.number(),
    saving3YrPercent: z.number(),
    commitmentType: z.string(),
    recommendation: z.enum(['strong', 'moderate', 'review']),
    rationale: z.string(),
  })),
  totalOnDemandMonthly: z.number(),
  totalReservedMonthly: z.number(),
  totalSavingMonthly: z.number(),
  totalSavingAnnual: z.number(),
  eligibleCount: z.number(),
  skippedCount: z.number(),
}).openapi("ReservedInstancesResponse");

// ── POST /api/valuation/budget-alerts ──────────────────────────────────────

export const budgetAlertsBody = z.object({
  sessionId: z.string().optional(),
  monthlyBudget: z.number({ coerce: true }),
  emails: z.union([
    z.array(z.string().email()),
    z.string().transform((s) => s.split(',').map(e => e.trim()).filter(Boolean)),
  ]).pipe(z.array(z.string().email())),
  thresholds: z.array(z.number().min(1).max(200)).optional().default([80, 100, 120]),
  resourceGroupName: z.string().optional(),
}).passthrough().openapi("BudgetAlertsBody");

export const budgetAlertsResponse = z.object({
  success: z.boolean(),
  budgetName: z.string(),
  budgetId: z.string().optional(),
  amount: z.number(),
  scope: z.string(),
  thresholds: z.array(z.number()),
  emailCount: z.number(),
  emails: z.array(z.string()),
  portalUrl: z.string().optional(),
}).openapi("BudgetAlertsResponse");

// ── POST /api/valuation/multicloud-compare ─────────────────────────────────

export const multicloudCompareBody = z.object({
  resources: z.array(valuationResourceSchema),
}).passthrough().openapi("MulticloudCompareBody");

export const multicloudCompareResponse = z.object({
  lineItems: z.array(z.object({
    resourceName: z.string(),
    role: z.string(),
    azureSku: z.string(),
    azureMonthly: z.number(),
    awsEquivalent: z.string(),
    awsMonthly: z.number(),
    gcpEquivalent: z.string(),
    gcpMonthly: z.number(),
  })),
  totals: z.object({
    azure: z.number(),
    aws: z.number(),
    gcp: z.number(),
  }),
  annualTotals: z.object({
    azure: z.number(),
    aws: z.number(),
    gcp: z.number(),
  }),
  cheapestProvider: z.enum(['azure', 'aws', 'gcp']),
  savingVsAzure: z.object({
    aws: z.number(),
    gcp: z.number(),
  }),
  insights: z.array(z.string()),
  resourceCount: z.number(),
}).openapi("MulticloudCompareResponse");
