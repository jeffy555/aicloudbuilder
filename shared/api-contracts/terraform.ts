import { z } from "zod";

// POST /api/sessions/:id/configure-backend
export const configureBackendBody = z.object({
  hasBackend: z.boolean().optional(),
  backendType: z.string().optional(),
  storageAccountName: z.string().optional(),
  resourceGroupName: z.string().optional(),
  containerName: z.string().optional(),
  stateFileKey: z.string().optional(),
  location: z.string().optional(),
  declined: z.boolean().optional(),
}).passthrough().openapi("ConfigureBackendBody");

export const configureBackendResponse = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  session: z.any().optional(),
}).passthrough().openapi("ConfigureBackendResponse");

// POST /api/sessions/:id/refactor
export const refactorBody = z.object({
  description: z.string().optional(),
}).passthrough().openapi("RefactorBody");

export const refactorResponse = z.object({
  success: z.boolean(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  message: z.string().optional(),
}).passthrough().openapi("RefactorResponse");

// POST /api/sessions/:id/refactor-fix
export const refactorFixBody = z.object({
  checkId: z.string().optional(),
  resourceType: z.string().optional(),
  fileName: z.string().optional(),
}).passthrough().openapi("RefactorFixBody");

export const refactorFixResponse = z.object({
  success: z.boolean(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
}).passthrough().openapi("RefactorFixResponse");

// POST /api/sessions/:id/generate-diagram
export const generateDiagramBody = z.object({
  diagramType: z.string().optional(),
}).passthrough().openapi("GenerateDiagramBody");

export const generateDiagramResponse = z.object({
  mermaidSyntax: z.string(),
  components: z.array(z.any()).optional(),
  relationships: z.array(z.any()).optional(),
  metadata: z.any().optional(),
}).passthrough().openapi("GenerateDiagramResponse");

// POST /api/terraform/validate-policy
export const validatePolicyBody = z.object({
  files: z.array(z.object({ fileName: z.string(), content: z.string() })),
  provider: z.string().optional(),
}).openapi("ValidatePolicyBody");

export const validatePolicyResponse = z.object({
  violations: z.array(z.any()),
  summary: z.any(),
}).passthrough().openapi("ValidatePolicyResponse");

// POST /api/sessions/:id/rightsizing-recommendations
export const rightsizingBody = z.object({}).passthrough().openapi("RightsizingBody");

export const rightsizingResponse = z.object({
  recommendations: z.array(z.any()),
}).passthrough().openapi("RightsizingResponse");

// POST /api/sessions/:id/apply-rightsizing — apply one AI rightsizing suggestion to session .tf files
export const applyRightsizingBody = z.object({
  resourceType: z.string().min(1),
  resourceName: z.string().min(1),
  attribute: z.string().min(1),
  currentValue: z.string().min(1),
  suggestedValue: z.string().min(1),
}).openapi("ApplyRightsizingBody");

export const applyRightsizingResponse = z.object({
  success: z.boolean(),
  fileName: z.string().optional(),
  fileId: z.string().optional(),
  message: z.string().optional(),
}).passthrough().openapi("ApplyRightsizingResponse");

// POST /api/terraform/analyze-plan-diff
export const analyzePlanDiffBody = z.object({
  planJson: z.any(),
}).passthrough().openapi("AnalyzePlanDiffBody");

export const analyzePlanDiffResponse = z.object({
  diff: z.any(),
}).passthrough().openapi("AnalyzePlanDiffResponse");
