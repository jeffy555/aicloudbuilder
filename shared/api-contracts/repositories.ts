import { z } from "zod";

const repositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  fullName: z.string().optional(),
  lastUpdated: z.string().optional(),
  branch: z.string().optional(),
}).openapi("Repository");

// POST /api/repositories/:provider/prewarm
export const prewarmQuery = z.object({
  serverType: z.enum(["devops", "cloud"]).default("devops").optional(),
});
export const prewarmResponse = z.object({
  status: z.string(),
  provider: z.string(),
  serverType: z.string(),
}).openapi("PrewarmResponse");

// GET /api/repositories/:provider
export const listReposResponse = z.array(repositorySchema).openapi("RepositoryList");

// POST /api/repositories/:provider
export const createRepoBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
}).openapi("CreateRepoBody");
export const createRepoResponse = repositorySchema;

// GET /api/sessions/:id/branches
export const branchesResponse = z.object({
  branches: z.array(z.string()),
  defaultBranch: z.string(),
}).openapi("BranchesResponse");

// POST /api/sessions/:id/scan-repository
export const scanRepoBody = z.object({
  refresh: z.boolean().default(false).optional(),
}).openapi("ScanRepoBody");

export const terraformGeneratorMetadataSchema = z
  .object({
    schemaVersion: z.number(),
    generator: z.literal("AICloudBuilder"),
    moduleApproach: z.string().nullable(),
    cloudProvider: z.string().nullable(),
    generatedAt: z.string(),
  })
  .openapi("TerraformGeneratorMetadata");

export const scanRepoResponse = z.object({
  isExisting: z.boolean(),
  cloudProvider: z.string().nullable(),
  moduleType: z.string().nullable(),
  terraformFiles: z.array(z.string()),
  terraformFilesWithContent: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  existingResources: z.array(z.object({ type: z.string(), name: z.string(), file: z.string() })).optional(),
  hasResources: z.boolean(),
  hasModules: z.boolean(),
  providerBlocks: z.array(z.string()),
  backend: z.any(),
  refreshed: z.boolean().optional(),
  filesStored: z.number().optional(),
  /** Present when `.aicloudbuilder.json` was written by this app during Terraform generation */
  createdByAICloudBuilder: z.boolean().optional(),
  generatorMetadata: terraformGeneratorMetadataSchema.nullable().optional(),
}).openapi("ScanRepoResponse");

// POST /api/sessions/:id/validate-aggregated-resources
export const validateAggregatedBody = z.object({
  description: z.string().min(1),
  childModuleResources: z.array(z.any()).min(1),
}).openapi("ValidateAggregatedBody");

export const validateAggregatedResponse = z.object({
  valid: z.boolean(),
  message: z.string(),
  requestedResources: z.array(z.string()),
  availableResources: z.array(z.string()),
}).openapi("ValidateAggregatedResponse");

// POST /api/sessions/:id/scan-child-module
export const scanChildModuleBody = z.object({
  repositoryId: z.string().min(1),
  provider: z.string().min(1),
}).openapi("ScanChildModuleBody");

export const scanChildModuleResponse = z.object({
  resources: z.array(z.object({ type: z.string(), name: z.string(), description: z.string() })),
  totalResources: z.number().optional(),
  message: z.string(),
}).openapi("ScanChildModuleResponse");
