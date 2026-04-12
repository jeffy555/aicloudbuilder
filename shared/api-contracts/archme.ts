import { z } from "zod";

// GET /api/archme/templates
export const templatesResponse = z.array(z.any()).openapi("ArchMeTemplates");

// GET /api/archme/templates/:id
export const templateByIdResponse = z.any().openapi("ArchMeTemplate");

// GET /api/archme/compliance-presets
export const compliancePresetsResponse = z.array(z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  description: z.string(),
})).openapi("CompliancePresets");

// GET /api/archme/compliance-presets/:id
export const compliancePresetByIdResponse = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  description: z.string(),
  requiredComponents: z.array(z.string()),
  forbiddenPatterns: z.array(z.string()),
  additionalRequirements: z.array(z.string()),
  regionConstraints: z.array(z.string()).optional(),
}).openapi("CompliancePreset");

// GET /api/sessions/:id/architecture-versions
export const archVersionsResponse = z.array(z.object({
  id: z.string(),
  sessionId: z.string(),
  version: z.number(),
  label: z.string().nullable(),
  diagramType: z.string().nullable(),
  createdAt: z.coerce.date(),
})).openapi("ArchVersionsList");

// POST /api/sessions/:id/restore-architecture-version
export const restoreVersionBody = z.object({
  versionId: z.string().min(1),
}).openapi("RestoreVersionBody");

export const restoreVersionResponse = z.object({
  success: z.boolean(),
  analysis: z.any(),
  mermaidSyntax: z.string().nullable(),
  diagramType: z.string().nullable(),
  components: z.any().nullable(),
  code: z.any().nullable(),
}).passthrough().openapi("RestoreVersionResponse");

// POST /api/sessions/:id/analyze-architecture
export const analyzeArchBody = z.object({
  requirements: z.string().min(1),
  compliancePresets: z.array(z.string()).optional(),
}).openapi("AnalyzeArchBody");

export const analyzeArchResponse = z.object({
  analysis: z.any(),
  versionNumber: z.number().optional(),
}).passthrough().openapi("AnalyzeArchResponse");

// POST /api/sessions/:id/validate-empty-repo
export const validateEmptyRepoBody = z.object({}).passthrough().openapi("ValidateEmptyRepoBody");
export const validateEmptyRepoResponse = z.object({
  isEmpty: z.boolean(),
  message: z.string().optional(),
}).passthrough().openapi("ValidateEmptyRepoResponse");

// POST /api/sessions/:id/generate-architecture-diagram
export const generateArchDiagramBody = z.object({
  diagramType: z.string().optional(),
}).passthrough().openapi("GenerateArchDiagramBody");

export const generateArchDiagramResponse = z.object({
  mermaidSyntax: z.string(),
  components: z.array(z.any()).optional(),
  relationships: z.array(z.any()).optional(),
  metadata: z.any().optional(),
}).passthrough().openapi("GenerateArchDiagramResponse");

// POST /api/sessions/:id/diagram-image
export const diagramImageBody = z.object({
  mermaidSyntax: z.string().min(1),
  format: z.enum(["png", "svg", "jpeg"]).default("png").optional(),
}).openapi("DiagramImageBody");

export const diagramImageResponse = z.object({
  image: z.string(),
  format: z.string(),
}).passthrough().openapi("DiagramImageResponse");

// POST /api/sessions/:id/extract-components
export const extractComponentsBody = z.object({}).passthrough().openapi("ExtractComponentsBody");
export const extractComponentsResponse = z.object({
  components: z.array(z.any()),
}).passthrough().openapi("ExtractComponentsResponse");

// POST /api/sessions/:id/generate-component-code
export const generateComponentCodeBody = z.object({
  components: z.array(z.any()).optional(),
}).passthrough().openapi("GenerateComponentCodeBody");

export const generateComponentCodeResponse = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
}).passthrough().openapi("GenerateComponentCodeResponse");

// POST /api/sessions/:id/scan-archme-code
export const scanArchMeCodeBody = z.object({}).passthrough().openapi("ScanArchMeCodeBody");
export const scanArchMeCodeResponse = z.object({
  results: z.any(),
}).passthrough().openapi("ScanArchMeCodeResponse");

// POST /api/sessions/:id/generate-archme-readme
export const generateReadmeBody = z.object({}).passthrough().openapi("GenerateReadmeBody");
export const generateReadmeResponse = z.object({
  readme: z.string(),
}).passthrough().openapi("GenerateReadmeResponse");

// POST /api/sessions/:id/commit-archme-code
export const commitArchMeBody = z.object({}).passthrough().openapi("CommitArchMeBody");
export const commitArchMeResponse = z.object({
  success: z.boolean(),
  commitMessage: z.string().optional(),
  result: z.any().optional(),
}).passthrough().openapi("CommitArchMeResponse");

// POST /api/sessions/:id/regenerate-component
export const regenerateComponentBody = z.object({
  componentName: z.string().optional(),
}).passthrough().openapi("RegenerateComponentBody");

export const regenerateComponentResponse = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
}).passthrough().openapi("RegenerateComponentResponse");

// POST /api/sessions/:id/validate-archme-terraform
export const validateArchMeTfBody = z.object({}).passthrough().openapi("ValidateArchMeTfBody");
export const validateArchMeTfResponse = z.object({
  valid: z.boolean(),
  errors: z.array(z.any()).optional(),
}).passthrough().openapi("ValidateArchMeTfResponse");
