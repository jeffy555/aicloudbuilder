import { z } from "zod";

// POST /api/sessions/:id/generate-kubernetes-manifests
export const generateK8sManifestsBody = z.object({
  description: z.string().optional(),
  manifests: z.array(z.any()).optional(),
}).passthrough().openapi("GenerateK8sManifestsBody");

export const generateK8sManifestsResponse = z.object({
  success: z.boolean(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  message: z.string().optional(),
}).passthrough().openapi("GenerateK8sManifestsResponse");

// POST /api/sessions/:id/commit-kubernetes
export const commitK8sBody = z.object({}).passthrough().openapi("CommitK8sBody");
export const commitK8sResponse = z.object({
  success: z.boolean(),
  commitMessage: z.string().optional(),
  result: z.any().optional(),
}).passthrough().openapi("CommitK8sResponse");

// POST /api/sessions/:id/scan-kubernetes
export const scanK8sBody = z.object({}).passthrough().openapi("ScanK8sBody");
export const scanK8sResponse = z.object({
  results: z.any(),
}).passthrough().openapi("ScanK8sResponse");

// POST /api/sessions/:id/validate-kubernetes
export const validateK8sBody = z.object({
  manifests: z.array(z.any()).optional(),
}).passthrough().openapi("ValidateK8sBody");

export const validateK8sResponse = z.object({
  results: z.array(z.any()),
}).passthrough().openapi("ValidateK8sResponse");

// POST /api/sessions/:id/fix-kubernetes-validation
export const fixK8sValidationBody = z.object({}).passthrough().openapi("FixK8sValidationBody");
export const fixK8sValidationResponse = z.object({
  success: z.boolean(),
  files: z.array(z.any()).optional(),
}).passthrough().openapi("FixK8sValidationResponse");

// POST /api/sessions/:id/validate-helm-chart
export const validateHelmBody = z.object({}).passthrough().openapi("ValidateHelmBody");
export const validateHelmResponse = z.object({
  results: z.array(z.any()),
}).passthrough().openapi("ValidateHelmResponse");

// POST /api/sessions/:id/generate-kubernetes-diagram
export const generateK8sDiagramBody = z.object({}).passthrough().openapi("GenerateK8sDiagramBody");
export const generateK8sDiagramResponse = z.object({
  mermaidSyntax: z.string(),
  metadata: z.any().optional(),
}).passthrough().openapi("GenerateK8sDiagramResponse");

// POST /api/sessions/:id/kubernetes-fix
export const k8sFixBody = z.object({
  findingId: z.string().optional(),
}).passthrough().openapi("K8sFixBody");
export const k8sFixResponse = z.object({
  success: z.boolean(),
  fixedFiles: z.array(z.any()).optional(),
}).passthrough().openapi("K8sFixResponse");

// POST /api/sessions/:id/kubernetes-fix/verify
export const k8sFixVerifyBody = z.object({}).passthrough().openapi("K8sFixVerifyBody");
export const k8sFixVerifyResponse = z.object({
  success: z.boolean(),
  results: z.any(),
}).passthrough().openapi("K8sFixVerifyResponse");

// POST /api/sessions/:id/kubernetes-fixes/batch
export const k8sFixBatchBody = z.object({
  findingIds: z.array(z.string()).optional(),
}).passthrough().openapi("K8sFixBatchBody");
export const k8sFixBatchResponse = z.object({
  success: z.boolean(),
  results: z.array(z.any()),
}).passthrough().openapi("K8sFixBatchResponse");

// POST /api/sessions/:id/scan-repo-for-helm
export const scanRepoForHelmBody = z.object({}).passthrough().openapi("ScanRepoForHelmBody");
export const scanRepoForHelmResponse = z.object({
  hasHelm: z.boolean(),
  charts: z.array(z.any()).optional(),
}).passthrough().openapi("ScanRepoForHelmResponse");

// POST /api/sessions/:id/analyze-repo
export const analyzeRepoBody = z.object({}).passthrough().openapi("AnalyzeRepoBody");
export const analyzeRepoResponse = z.object({
  analysis: z.any(),
}).passthrough().openapi("AnalyzeRepoResponse");

// POST /api/sessions/:id/generate-helm-chart
export const generateHelmChartBody = z.object({
  description: z.string().optional(),
  options: z.any().optional(),
}).passthrough().openapi("GenerateHelmChartBody");

export const generateHelmChartResponse = z.object({
  success: z.boolean(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  lintResults: z.any().optional(),
}).passthrough().openapi("GenerateHelmChartResponse");

// POST /api/sessions/:id/upload-helm-chart
export const uploadHelmChartBody = z.object({}).passthrough().openapi("UploadHelmChartBody");
export const uploadHelmChartResponse = z.object({
  success: z.boolean(),
  message: z.string().optional(),
}).passthrough().openapi("UploadHelmChartResponse");

// POST /api/sessions/:id/build-kustomize
export const buildKustomizeBody = z.object({}).passthrough().openapi("BuildKustomizeBody");
export const buildKustomizeResponse = z.object({
  success: z.boolean(),
  output: z.string().optional(),
}).passthrough().openapi("BuildKustomizeResponse");

// POST /api/sessions/:id/security-score
export const securityScoreBody = z.object({}).passthrough().openapi("SecurityScoreBody");
export const securityScoreResponse = z.object({
  score: z.number(),
  details: z.any().optional(),
}).passthrough().openapi("SecurityScoreResponse");

// GET /api/kubernetes/policy-hints
export const policyHintsResponse = z.object({
  hints: z.array(z.any()),
}).passthrough().openapi("PolicyHintsResponse");

// POST /api/sessions/:id/policy-check
export const policyCheckBody = z.object({}).passthrough().openapi("PolicyCheckBody");
export const policyCheckResponse = z.object({
  results: z.array(z.any()),
}).passthrough().openapi("PolicyCheckResponse");

// POST /api/sessions/:id/rightsize-kubernetes
export const rightsizeK8sBody = z.object({}).passthrough().openapi("RightsizeK8sBody");
export const rightsizeK8sResponse = z.object({
  recommendations: z.array(z.any()),
}).passthrough().openapi("RightsizeK8sResponse");

// POST /api/sessions/:id/estimate-k8s-cost
export const estimateK8sCostBody = z.object({}).passthrough().openapi("EstimateK8sCostBody");
export const estimateK8sCostResponse = z.object({
  estimate: z.any(),
}).passthrough().openapi("EstimateK8sCostResponse");
