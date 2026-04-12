import { z } from "zod";

// POST /api/sessions/:id/docker-scan
export const dockerScanBody = z.object({}).passthrough().openapi("DockerScanBody");
export const dockerScanResponse = z.object({
  success: z.boolean(),
  results: z.any(),
}).passthrough().openapi("DockerScanResponse");

// POST /api/sessions/:id/generate-dockerfile
export const generateDockerfileBody = z.object({
  description: z.string().optional(),
  language: z.string().optional(),
  framework: z.string().optional(),
}).passthrough().openapi("GenerateDockerfileBody");

export const generateDockerfileResponse = z.object({
  success: z.boolean(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
}).passthrough().openapi("GenerateDockerfileResponse");

// POST /api/sessions/:id/scan-docker
export const scanDockerBody = z.object({}).passthrough().openapi("ScanDockerBody");
export const scanDockerResponse = z.object({
  results: z.any(),
}).passthrough().openapi("ScanDockerResponse");

// POST /api/sessions/:id/docker-best-practices
export const dockerBestPracticesBody = z.object({}).passthrough().openapi("DockerBestPracticesBody");
export const dockerBestPracticesResponse = z.object({
  results: z.array(z.any()),
}).passthrough().openapi("DockerBestPracticesResponse");

// POST /api/sessions/:id/docker-fix-best-practices
export const dockerFixBPBody = z.object({
  ruleId: z.string().optional(),
}).passthrough().openapi("DockerFixBPBody");

export const dockerFixBPResponse = z.object({
  success: z.boolean(),
  fixedFiles: z.array(z.any()).optional(),
}).passthrough().openapi("DockerFixBPResponse");

// POST /api/sessions/:id/generate-compose
export const generateComposeBody = z.object({}).passthrough().openapi("GenerateComposeBody");
export const generateComposeResponse = z.object({
  success: z.boolean(),
  compose: z.string().optional(),
}).passthrough().openapi("GenerateComposeResponse");

// POST /api/sessions/:id/image-size-estimate
export const imageSizeEstimateBody = z.object({}).passthrough().openapi("ImageSizeEstimateBody");
export const imageSizeEstimateResponse = z.object({
  estimates: z.array(z.any()),
}).passthrough().openapi("ImageSizeEstimateResponse");

// POST /api/sessions/:id/commit-docker
export const commitDockerBody = z.object({}).passthrough().openapi("CommitDockerBody");
export const commitDockerResponse = z.object({
  success: z.boolean(),
  commitMessage: z.string().optional(),
  result: z.any().optional(),
}).passthrough().openapi("CommitDockerResponse");

// POST /api/sessions/:id/generate-docker-diagram
export const generateDockerDiagramBody = z.object({}).passthrough().openapi("GenerateDockerDiagramBody");
export const generateDockerDiagramResponse = z.object({
  mermaidSyntax: z.string(),
  metadata: z.any().optional(),
}).passthrough().openapi("GenerateDockerDiagramResponse");
