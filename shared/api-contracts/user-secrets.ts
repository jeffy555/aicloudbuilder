import { z } from "zod";

// GET /api/user/secrets
export const userSecretsResponse = z.object({
  hasAzureDevOps: z.boolean(),
  hasAzureCloud: z.boolean(),
  hasGithub: z.boolean(),
  hasAws: z.boolean(),
  hasGcp: z.boolean(),
  azureDevOps: z.object({
    org: z.string(),
    project: z.string(),
    userId: z.string().optional(),
  }).nullable(),
  azureCloud: z.object({
    clientId: z.string(),
    tenantId: z.string(),
    subscriptionId: z.string(),
  }).nullable(),
  github: z.object({
    owner: z.string(),
  }).nullable(),
  aws: z.object({
    accessKeyId: z.string(),
    region: z.string(),
  }).nullable(),
  gcp: z.object({
    projectId: z.string(),
    region: z.string(),
  }).nullable(),
}).openapi("UserSecretsResponse");

// PUT /api/user/secrets/:type
export const saveSecretBody = z.object({}).passthrough().openapi("SaveSecretBody");
export const saveSecretResponse = z.object({
  message: z.string(),
}).openapi("SaveSecretResponse");
