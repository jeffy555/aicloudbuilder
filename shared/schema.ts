import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb, real, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id), // Link session to user
  provider: text("provider"), // 'github' | 'azure' | null
  repositoryId: text("repository_id"),
  repositoryName: text("repository_name"),
  repositoryBranch: text("repository_branch"),
  cloudProvider: text("cloud_provider"), // 'azure' | 'aws' | 'gcp' | null
  moduleApproach: text("module_approach"), // 'child-module' | 'standalone-root' | 'aggregated-root' | null
  currentStep: text("current_step").notNull().default('1'), // '1' | '2' | '3' | '4' | '5' | '6' | '7'
  workflowStep: text("workflow_step").notNull().default('landing'), // 'landing' | 'provider_selection' | 'repository_selection' | 'cloud_provider_selection' | 'module_approach_selection' | 'backend_configuration' | 'terraform_generation'
  activeModule: text("active_module"), // 'docker' | 'terraform' | 'automation' | etc.
  isExistingRepo: text("is_existing_repo"), // 'true' | 'false' | null (null = not scanned yet)
  detectedCloudProvider: text("detected_cloud_provider"), // 'azure' | 'aws' | 'gcp' | null
  detectedModuleType: text("detected_module_type"), // 'child' | 'root' | 'empty' | null
  detectedTerraformFiles: jsonb("detected_terraform_files"), // Array of file paths found
  archMeAnalysis: text("arch_me_analysis"), // Store ArchMe architecture analysis (JSON string)
  // Backend configuration tracking
  hasBackend: text("has_backend"), // 'true' | 'false' | null
  backendType: text("backend_type"), // 'azurerm' | 'aws' | 'gcs' | null
  backendStorageAccount: text("backend_storage_account"), // Azure storage account name
  backendResourceGroup: text("backend_resource_group"), // Azure resource group name
  backendContainer: text("backend_container"), // Azure container name or AWS S3 bucket
  backendStateKey: text("backend_state_key"), // State file key/path
  backendLocation: text("backend_location"), // Azure location for storage account
  backendValidated: text("backend_validated"), // 'true' | 'false' | 'pending' | 'skipped' | null
  backendDeclined: text("backend_declined"), // 'true' | 'false' | null (user chose to skip backend)
  // Valuation module fields
  scannedResources: text("scanned_resources"), // JSON string of scanned Azure resources
  scanTimestamp: text("scan_timestamp"), // ISO timestamp of last resource scan
  selectedResourceGroups: text("selected_resource_groups"), // JSON array of selected RG IDs
  usageMetricsCache: text("usage_metrics_cache"), // JSON cache of Azure Monitor metrics
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => sessions.id),
  type: text("type").notNull(), // 'ai' | 'user'
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const generatedFiles = pgTable("generated_files", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().references(() => sessions.id),
  fileName: text("file_name").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Phase 1: User-specific fix preferences table
export const userFixPreferences = pgTable("user_fix_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  checkId: text("check_id").notNull(), // e.g., "CKV_AZURE_59"
  resourceType: text("resource_type").notNull(), // e.g., "azurerm_storage_account"
  fixSnippet: text("fix_snippet").notNull(), // The actual fix code
  confidence: real("confidence").notNull().default(1.0), // 0.0 to 1.0
  timesUsed: integer("times_used").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  source: text("source").notNull(), // 'user_verified' | 'checkov' | 'ai_generated' | 'user_preference'
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Composite index for fast lookups by user + check + resource
  userFixLookupIdx: index("idx_user_fix_lookup").on(table.userId, table.checkId, table.resourceType),
  // Index for finding all fixes for a specific check
  checkLookupIdx: index("idx_check_lookup").on(table.checkId, table.resourceType),
  // Index for finding user's most used fixes
  userTimesUsedIdx: index("idx_user_times_used").on(table.userId, table.timesUsed),
}));

// User activity tracking for history feature
export const userActivities = pgTable("user_activities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  sessionId: varchar("session_id").references(() => sessions.id),
  module: text("module").notNull(), // 'terraform' | 'kubernetes' | 'automation' | 'archme' | 'docker' | 'scoreme'
  actionType: text("action_type").notNull(), // 'score_run' | 'session_create' | etc.
  actionLabel: text("action_label").notNull(), // Human-readable label
  metadata: jsonb("metadata"), // Flexible JSON for action-specific data
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userModuleIdx: index("idx_user_activities_user_module").on(table.userId, table.module),
  userCreatedIdx: index("idx_user_activities_user_created").on(table.userId, table.createdAt),
}));

// Insert schemas
export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  email: true,
  password: true,
});

export const insertSessionSchema = createInsertSchema(sessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export const insertGeneratedFileSchema = createInsertSchema(generatedFiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserFixPreferenceSchema = createInsertSchema(userFixPreferences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  // Add custom validation
  confidence: z.number().min(0).max(1.0),
  timesUsed: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  source: z.enum(['user_verified', 'checkov', 'ai_generated', 'user_preference']),
});

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

export type InsertGeneratedFile = z.infer<typeof insertGeneratedFileSchema>;
export type GeneratedFile = typeof generatedFiles.$inferSelect;

export type InsertUserFixPreference = z.infer<typeof insertUserFixPreferenceSchema>;
export type UserFixPreference = typeof userFixPreferences.$inferSelect;

export const insertUserActivitySchema = createInsertSchema(userActivities).omit({ id: true, createdAt: true });
export type InsertUserActivity = z.infer<typeof insertUserActivitySchema>;
export type UserActivity = typeof userActivities.$inferSelect;

// Additional types for API
export const repositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  fullName: z.string().optional(),
  lastUpdated: z.string().optional(),
  branch: z.string().optional(),
});

export type Repository = z.infer<typeof repositorySchema>;

export const backendConfigurationSchema = z.object({
  hasBackend: z.boolean(),
  backendType: z.enum(['azurerm', 'aws', 'gcs']).nullable(),
  storageAccountName: z.string().optional(),
  resourceGroupName: z.string().optional(),
  containerName: z.string().optional(),
  stateFileKey: z.string().optional(),
});

export type BackendConfiguration = z.infer<typeof backendConfigurationSchema>;

export const repositoryScanResultSchema = z.object({
  isExisting: z.boolean(),
  cloudProvider: z.enum(['azure', 'aws', 'gcp']).nullable(),
  moduleType: z.enum(['child', 'root', 'empty']).nullable(),
  terraformFiles: z.array(z.string()),
  terraformFilesWithContent: z.array(z.object({
    path: z.string(),
    content: z.string()
  })).optional(),
  existingResources: z.array(z.object({
    type: z.string(),
    name: z.string(),
    file: z.string()
  })).optional(),
  hasResources: z.boolean(),
  hasModules: z.boolean(),
  providerBlocks: z.array(z.string()),
  backend: backendConfigurationSchema,
});

export type RepositoryScanResult = z.infer<typeof repositoryScanResultSchema>;

export const scoreMeFindingSchema = z.object({
  category: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  message: z.string(),
  file: z.string().optional(),
  remediation: z.string(),
});

export const scoreMeFileDetailSchema = z.object({
  path: z.string(),
  description: z.string(),
  resources: z.array(z.string()).optional(),
});

export const scoreMeInventorySchema = z.object({
  type: z.enum(['terraform', 'kubernetes', 'helm', 'automation', 'bicep', 'arm', 'dockerfile', 'docker-compose']),
  path: z.string(),
  summary: z.string(),
  files: z.array(z.string()).optional(),
  fileDetails: z.array(scoreMeFileDetailSchema).optional(),
});

export const scoreMePillarSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(100),
  weight: z.number(),
  details: z.array(z.string()),
});

export const scoreMeReportSchema = z.object({
  repository: z.string(),
  provider: z.enum(['github', 'azure']),
  inventory: z.array(scoreMeInventorySchema),
  findings: z.array(scoreMeFindingSchema),
  pillarScores: z.array(scoreMePillarSchema),
  finalScore: z.number().min(0).max(100),
  confidence: z.enum(['Production-ready', 'Needs minor fixes', 'Risky', 'Not recommended', 'Empty Repository', 'Application Code Only']),
  updatedAt: z.string(),
});

export type ScoreMeReport = z.infer<typeof scoreMeReportSchema>;

// ─── Cost Analysis Types ────────────────────────────────────────────────────

export const costStatusSchema = z.enum(['exact', 'estimated', 'needs_input']);
export type CostStatus = z.infer<typeof costStatusSchema>;

export const usageProfileSchema = z.enum(['low', 'medium', 'high', 'custom']);
export type UsageProfile = z.infer<typeof usageProfileSchema>;

export const usageDimensionSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  defaultValue: z.number(),
});

export type UsageDimensionInfo = z.infer<typeof usageDimensionSchema>;

const reservedPricingTierSchema = z.object({
  monthlyCost: z.number(),
  savingsPercent: z.number(),
});

export const costResourceSchema = z.object({
  resourceName: z.string(),
  resourceType: z.string(),
  serviceName: z.string(),
  monthlyCost: z.number(),
  yearlyCost: z.number(),
  currency: z.string(),
  status: costStatusSchema,
  pricingMatchType: z.enum(['config_exact', 'config_broad', 'fallback', 'free', 'parent', 'unsupported']),
  confidenceScore: z.number().min(0).max(1),
  confidenceLabel: z.enum(['high', 'medium', 'low']),
  assumptionsUsed: z.array(z.string()),
  usageDimensions: z.array(usageDimensionSchema).optional(),
  providedUsage: z.record(z.string(), z.number()).optional(),
  unresolvedVariables: z.array(z.string()).optional(),
  details: z.any().optional(),
  // Fix #4: Reserved instance pricing comparison for compute resources
  reservedPricing: z.object({
    oneYear: reservedPricingTierSchema.optional(),
    threeYear: reservedPricingTierSchema.optional(),
  }).optional(),
});

export type CostResource = z.infer<typeof costResourceSchema>;

export const costSummarySchema = z.object({
  monthlyTotalExact: z.number(),
  monthlyTotalEstimated: z.number(),
  monthlyGrandTotal: z.number(),
  yearlyGrandTotal: z.number(),
  currency: z.string(),
  exactCount: z.number(),
  estimatedCount: z.number(),
  needsInputCount: z.number(),
  freeCount: z.number(),
  resourceCount: z.number(),
  profile: usageProfileSchema,
});

export type CostSummary = z.infer<typeof costSummarySchema>;

const envProfileEntrySchema = z.object({
  monthlyTotal: z.number(),
  yearlyTotal: z.number(),
  description: z.string(),
});

export const costAnalysisResultSchema = z.object({
  success: z.boolean(),
  summary: costSummarySchema,
  resources: z.array(costResourceSchema),
  skippedResources: z.array(z.object({
    resourceType: z.string(),
    resourceName: z.string(),
    reason: z.string(),
  })).optional(),
  logs: z.array(z.string()).optional(),
  // Fix #3: Multi-environment cost comparison
  environmentComparison: z.object({
    dev: envProfileEntrySchema,
    test: envProfileEntrySchema,
    prod: envProfileEntrySchema,
    activeProfile: z.string(),
  }).optional(),
});

export type CostAnalysisResult = z.infer<typeof costAnalysisResultSchema>;

export const costAnalysisRequestSchema = z.object({
  profile: usageProfileSchema.optional().default('medium'),
  customUsage: z.record(z.string(), z.record(z.string(), z.number())).optional(),
});

export type CostAnalysisRequest = z.infer<typeof costAnalysisRequestSchema>;

// ─── Valuation Module Types ─────────────────────────────────────────────────

export const azureResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(), // Azure ARM type (e.g., Microsoft.Storage/storageAccounts)
  location: z.string(),
  resourceGroup: z.string(),
  sku: z.string().optional(),
  tier: z.string().optional(),
  properties: z.any().optional(),
  actualCostMTD: z.number().optional(), // Actual cost month-to-date from Azure Cost Management
});

export type AzureResource = z.infer<typeof azureResourceSchema>;

export const remediationPlanSchema = z.object({
  recommended_sku: z.string(),
  recommended_tier: z.string().optional(),
  savings_monthly: z.number(),
  savings_percent: z.number(),
  reason: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  action_required: z.string(),
});

export type RemediationPlan = z.infer<typeof remediationPlanSchema>;

export const valuationResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(), // Friendly name (e.g., "Storage Account")
  azureType: z.string(), // Original Azure ARM type
  terraformType: z.string().optional(), // Mapped Terraform type
  location: z.string(),
  resourceGroup: z.string(),
  currentSku: z.string(),
  currentTier: z.string().optional(),
  monthlyCost: z.number(),
  yearlyCost: z.number(),
  currency: z.string().default('USD'),
  remediation: remediationPlanSchema.optional(),
  pricingDetails: z.any().optional(),
  usageMetrics: z.lazy(() => usageMetricsSchema).optional(), // Azure Monitor metrics
  metricsAvailable: z.boolean().default(false), // Whether metrics were fetched
});

export type ValuationResource = z.infer<typeof valuationResourceSchema>;

export const valuationSummarySchema = z.object({
  totalMonthlyCost: z.number(),
  totalYearlyCost: z.number(),
  potentialSavings: z.number(),
  savingsPercent: z.number(),
  resourceCount: z.number(),
  recommendationCount: z.number(),
});

export type ValuationSummary = z.infer<typeof valuationSummarySchema>;

// Resource Group Summary for selection UI
export const resourceGroupSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string(),
  resourceCount: z.number(),
  estimatedMonthlyCost: z.number().optional(),
  tags: z.record(z.string()).optional()
});

export type ResourceGroupSummary = z.infer<typeof resourceGroupSummarySchema>;

// Usage Metrics from Azure Monitor
export const usageMetricsSchema = z.object({
  resourceId: z.string(),
  resourceType: z.string(),
  timespan: z.object({
    start: z.string(),
    end: z.string()
  }),
  metrics: z.array(z.object({
    name: z.string(),
    unit: z.string(),
    timeseries: z.array(z.object({
      data: z.array(z.object({
        timeStamp: z.string(),
        average: z.number().optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional()
      }))
    }))
  })),
  statistics: z.object({
    avgCpuPercent: z.number().optional(),
    maxCpuPercent: z.number().optional(),
    avgMemoryPercent: z.number().optional(),
    avgStorageUsedGB: z.number().optional(),
    avgDtuPercent: z.number().optional(),
    sampleCount: z.number()
  }).optional()
});

export type UsageMetrics = z.infer<typeof usageMetricsSchema>;
