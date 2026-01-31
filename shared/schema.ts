import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
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

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

export type InsertGeneratedFile = z.infer<typeof insertGeneratedFileSchema>;
export type GeneratedFile = typeof generatedFiles.$inferSelect;

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

export const scoreMeInventorySchema = z.object({
  type: z.enum(['terraform', 'kubernetes', 'helm', 'dockerfile', 'automation']),
  path: z.string(),
  summary: z.string(),
  files: z.array(z.string()).optional(),
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
  confidence: z.enum(['Production-ready', 'Needs minor fixes', 'Risky', 'Not recommended']),
  updatedAt: z.string(),
});

export type ScoreMeReport = z.infer<typeof scoreMeReportSchema>;
