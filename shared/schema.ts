import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  provider: text("provider"), // 'github' | 'azure' | null
  repositoryId: text("repository_id"),
  repositoryName: text("repository_name"),
  cloudProvider: text("cloud_provider"), // 'azure' | 'aws' | 'gcp' | null
  moduleApproach: text("module_approach"), // 'child-module' | 'standalone-root' | 'aggregated-root' | null
  currentStep: text("current_step").notNull().default('1'), // '1' | '2' | '3' | '4' | '5' | '6'
  isExistingRepo: text("is_existing_repo"), // 'true' | 'false' | null (null = not scanned yet)
  detectedCloudProvider: text("detected_cloud_provider"), // 'azure' | 'aws' | 'gcp' | null
  detectedModuleType: text("detected_module_type"), // 'child' | 'root' | 'empty' | null
  detectedTerraformFiles: jsonb("detected_terraform_files"), // Array of file paths found
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
  lastUpdated: z.string().optional(),
  branch: z.string().optional(),
});

export type Repository = z.infer<typeof repositorySchema>;

export const repositoryScanResultSchema = z.object({
  isExisting: z.boolean(),
  cloudProvider: z.enum(['azure', 'aws', 'gcp']).nullable(),
  moduleType: z.enum(['child', 'root', 'empty']).nullable(),
  terraformFiles: z.array(z.string()),
  hasResources: z.boolean(),
  hasModules: z.boolean(),
  providerBlocks: z.array(z.string()),
});

export type RepositoryScanResult = z.infer<typeof repositoryScanResultSchema>;
