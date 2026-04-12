/**
 * OpenAPI 3.0 Registry
 *
 * Registers every endpoint from shared/api-contracts/ into an OpenAPI registry.
 * The registry is used to:
 *  1. Generate the openapi.json spec (via generate-spec.ts)
 *  2. Serve the spec at /api/openapi.json at runtime
 */
// Setup MUST be imported first — extends Zod with .openapi() before any contract module loads
import "@shared/api-contracts/setup";

import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Import all contract modules
import * as health from "@shared/api-contracts/health";
import * as auth from "@shared/api-contracts/auth";
import * as sessions from "@shared/api-contracts/sessions";
import * as files from "@shared/api-contracts/files";
import * as repositories from "@shared/api-contracts/repositories";
import * as terraform from "@shared/api-contracts/terraform";
import * as terraformGeneration from "@shared/api-contracts/terraform-generation";
import * as docker from "@shared/api-contracts/docker";
import * as kubernetes from "@shared/api-contracts/kubernetes";
import * as archme from "@shared/api-contracts/archme";
import * as automation from "@shared/api-contracts/automation";
import * as valuation from "@shared/api-contracts/valuation";
import * as commit from "@shared/api-contracts/commit";
import * as scan from "@shared/api-contracts/scan";
import * as fixes from "@shared/api-contracts/fixes";
import * as costAnalysis from "@shared/api-contracts/cost-analysis";
import * as scoreme from "@shared/api-contracts/scoreme";
import * as activities from "@shared/api-contracts/activities";
import * as metrics from "@shared/api-contracts/metrics";
import * as debug from "@shared/api-contracts/debug";
import * as history from "@shared/api-contracts/history";
import * as userSecrets from "@shared/api-contracts/user-secrets";
import * as userFixPreferences from "@shared/api-contracts/user-fix-preferences";
import { errorResponse, sessionIdParams, providerParams, fileIdParams, secretTypeParams } from "@shared/api-contracts/common";

export const registry = new OpenAPIRegistry();

// Helper to register JSON body + response
function jsonBody(schema: z.ZodTypeAny) {
  return { body: { content: { "application/json": { schema } } } };
}

function jsonResponse(description: string, schema: z.ZodTypeAny) {
  return { description, content: { "application/json": { schema } } };
}

function errResponse(description: string) {
  return { description, content: { "application/json": { schema: errorResponse } } };
}

// ── Health ───────────────────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/health", responses: { 200: jsonResponse("OK", health.healthResponse) } });

// ── Auth ─────────────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/auth/signup", request: jsonBody(auth.signupBody), responses: { 201: jsonResponse("User created", auth.signupResponse), 400: errResponse("Validation error") } });
registry.registerPath({ method: "post", path: "/api/auth/login", request: jsonBody(auth.loginBody), responses: { 200: jsonResponse("Login OK", auth.loginResponse), 401: errResponse("Invalid credentials") } });
registry.registerPath({ method: "post", path: "/api/auth/logout", responses: { 200: jsonResponse("Logged out", auth.logoutResponse) } });
registry.registerPath({ method: "get", path: "/api/auth/me", responses: { 200: jsonResponse("Current user", auth.meResponse), 401: errResponse("Not authenticated") } });

// ── Sessions ────────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions", responses: { 200: jsonResponse("Session created", sessions.createSessionResponse) } });
registry.registerPath({ method: "get", path: "/api/sessions/{id}", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Session", sessions.getSessionResponse), 404: errResponse("Not found") } });
registry.registerPath({ method: "patch", path: "/api/sessions/{id}", request: { params: sessionIdParams, ...jsonBody(sessions.updateSessionBody) }, responses: { 200: jsonResponse("Updated", sessions.updateSessionResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/reset", request: { params: sessionIdParams, ...jsonBody(sessions.resetSessionBody) }, responses: { 200: jsonResponse("Reset", sessions.resetSessionResponse) } });
registry.registerPath({ method: "get", path: "/api/sessions/{id}/messages", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Messages", sessions.getMessagesResponse) } });
registry.registerPath({ method: "get", path: "/api/sessions/{id}/files-debug", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Debug info", sessions.filesDebugResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/messages/system", request: { params: sessionIdParams, ...jsonBody(sessions.systemMessageBody) }, responses: { 200: jsonResponse("System message", sessions.systemMessageResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/chat", request: { params: sessionIdParams, ...jsonBody(sessions.chatBody) }, responses: { 200: jsonResponse("Chat response", sessions.chatResponse) } });

// ── Files ───────────────────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/sessions/{id}/files", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Files", files.getFilesResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/files", request: { params: sessionIdParams, ...jsonBody(files.createFileBody) }, responses: { 201: jsonResponse("File created", files.createFileResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/files/bulk", request: { params: sessionIdParams, ...jsonBody(files.bulkFilesBody) }, responses: { 200: jsonResponse("Bulk update", files.bulkFilesResponse) } });
registry.registerPath({ method: "patch", path: "/api/files/{id}", request: { params: fileIdParams, ...jsonBody(files.updateFileBody) }, responses: { 200: jsonResponse("Updated", files.updateFileResponse) } });

// ── Repositories ────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/repositories/{provider}/prewarm", request: { params: providerParams }, responses: { 200: jsonResponse("Pre-warming", repositories.prewarmResponse) } });
registry.registerPath({ method: "get", path: "/api/repositories/{provider}", request: { params: providerParams }, responses: { 200: jsonResponse("Repositories", repositories.listReposResponse) } });
registry.registerPath({ method: "post", path: "/api/repositories/{provider}", request: { params: providerParams, ...jsonBody(repositories.createRepoBody) }, responses: { 200: jsonResponse("Repository created", repositories.createRepoResponse) } });
registry.registerPath({ method: "get", path: "/api/sessions/{id}/branches", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Branches", repositories.branchesResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/scan-repository", request: { params: sessionIdParams, ...jsonBody(repositories.scanRepoBody) }, responses: { 200: jsonResponse("Scan result", repositories.scanRepoResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/validate-aggregated-resources", request: { params: sessionIdParams, ...jsonBody(repositories.validateAggregatedBody) }, responses: { 200: jsonResponse("Validation result", repositories.validateAggregatedResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/scan-child-module", request: { params: sessionIdParams, ...jsonBody(repositories.scanChildModuleBody) }, responses: { 200: jsonResponse("Child module resources", repositories.scanChildModuleResponse) } });

// ── Terraform ───────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/configure-backend", request: { params: sessionIdParams, ...jsonBody(terraform.configureBackendBody) }, responses: { 200: jsonResponse("Backend configured", terraform.configureBackendResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/refactor", request: { params: sessionIdParams, ...jsonBody(terraform.refactorBody) }, responses: { 200: jsonResponse("Refactored", terraform.refactorResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/refactor-fix", request: { params: sessionIdParams, ...jsonBody(terraform.refactorFixBody) }, responses: { 200: jsonResponse("Fix applied", terraform.refactorFixResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-diagram", request: { params: sessionIdParams, ...jsonBody(terraform.generateDiagramBody) }, responses: { 200: jsonResponse("Diagram", terraform.generateDiagramResponse) } });
registry.registerPath({ method: "post", path: "/api/terraform/validate-policy", request: jsonBody(terraform.validatePolicyBody), responses: { 200: jsonResponse("Policy validation", terraform.validatePolicyResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/rightsizing-recommendations", request: { params: sessionIdParams, ...jsonBody(terraform.rightsizingBody) }, responses: { 200: jsonResponse("Rightsizing", terraform.rightsizingResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/apply-rightsizing", request: { params: sessionIdParams, ...jsonBody(terraform.applyRightsizingBody) }, responses: { 200: jsonResponse("Applied", terraform.applyRightsizingResponse) } });
registry.registerPath({ method: "post", path: "/api/terraform/analyze-plan-diff", request: jsonBody(terraform.analyzePlanDiffBody), responses: { 200: jsonResponse("Plan diff", terraform.analyzePlanDiffResponse) } });

// ── Terraform Generation ────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-terraform", request: { params: sessionIdParams, ...jsonBody(terraformGeneration.generateTerraformBody) }, responses: { 200: jsonResponse("Generated", terraformGeneration.generateTerraformResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/terraform-cli-repair", request: { params: sessionIdParams, ...jsonBody(terraformGeneration.terraformCliRepairBody) }, responses: { 200: jsonResponse("CLI repair", terraformGeneration.terraformCliRepairResponse), 400: errResponse("Cannot repair") } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/terraform-cicd-repair", request: { params: sessionIdParams, ...jsonBody(terraformGeneration.terraformCicdRepairBody) }, responses: { 200: jsonResponse("CI/CD repair", terraformGeneration.terraformCicdRepairResponse), 400: errResponse("Bad request") } });

// ── Docker ──────────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/docker-scan", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Scan", docker.dockerScanResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-dockerfile", request: { params: sessionIdParams, ...jsonBody(docker.generateDockerfileBody) }, responses: { 200: jsonResponse("Dockerfile", docker.generateDockerfileResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/scan-docker", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Docker scan", docker.scanDockerResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/docker-best-practices", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Best practices", docker.dockerBestPracticesResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/docker-fix-best-practices", request: { params: sessionIdParams, ...jsonBody(docker.dockerFixBPBody) }, responses: { 200: jsonResponse("Fixed", docker.dockerFixBPResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-compose", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Compose", docker.generateComposeResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/image-size-estimate", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Estimates", docker.imageSizeEstimateResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/commit-docker", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Committed", docker.commitDockerResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-docker-diagram", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Diagram", docker.generateDockerDiagramResponse) } });

// ── Kubernetes ──────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-kubernetes-manifests", request: { params: sessionIdParams, ...jsonBody(kubernetes.generateK8sManifestsBody) }, responses: { 200: jsonResponse("Manifests", kubernetes.generateK8sManifestsResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/commit-kubernetes", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Committed", kubernetes.commitK8sResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/scan-kubernetes", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Scan results", kubernetes.scanK8sResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/validate-kubernetes", request: { params: sessionIdParams, ...jsonBody(kubernetes.validateK8sBody) }, responses: { 200: jsonResponse("Validation", kubernetes.validateK8sResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/fix-kubernetes-validation", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Fixed", kubernetes.fixK8sValidationResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/validate-helm-chart", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Helm validation", kubernetes.validateHelmResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-kubernetes-diagram", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Diagram", kubernetes.generateK8sDiagramResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/kubernetes-fix", request: { params: sessionIdParams, ...jsonBody(kubernetes.k8sFixBody) }, responses: { 200: jsonResponse("Fix applied", kubernetes.k8sFixResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/kubernetes-fix/verify", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Verified", kubernetes.k8sFixVerifyResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/kubernetes-fixes/batch", request: { params: sessionIdParams, ...jsonBody(kubernetes.k8sFixBatchBody) }, responses: { 200: jsonResponse("Batch fix", kubernetes.k8sFixBatchResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/scan-repo-for-helm", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Helm scan", kubernetes.scanRepoForHelmResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/analyze-repo", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Analysis", kubernetes.analyzeRepoResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-helm-chart", request: { params: sessionIdParams, ...jsonBody(kubernetes.generateHelmChartBody) }, responses: { 200: jsonResponse("Helm chart", kubernetes.generateHelmChartResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/upload-helm-chart", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Uploaded", kubernetes.uploadHelmChartResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/build-kustomize", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Built", kubernetes.buildKustomizeResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/security-score", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Score", kubernetes.securityScoreResponse) } });
registry.registerPath({ method: "get", path: "/api/kubernetes/policy-hints", responses: { 200: jsonResponse("Hints", kubernetes.policyHintsResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/policy-check", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Check", kubernetes.policyCheckResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/rightsize-kubernetes", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Recommendations", kubernetes.rightsizeK8sResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/estimate-k8s-cost", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Cost estimate", kubernetes.estimateK8sCostResponse) } });

// ── ArchMe ──────────────────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/archme/templates", responses: { 200: jsonResponse("Templates", archme.templatesResponse) } });
registry.registerPath({ method: "get", path: "/api/archme/templates/{id}", responses: { 200: jsonResponse("Template", archme.templateByIdResponse) } });
registry.registerPath({ method: "get", path: "/api/archme/compliance-presets", responses: { 200: jsonResponse("Presets", archme.compliancePresetsResponse) } });
registry.registerPath({ method: "get", path: "/api/archme/compliance-presets/{id}", responses: { 200: jsonResponse("Preset", archme.compliancePresetByIdResponse) } });
registry.registerPath({ method: "get", path: "/api/sessions/{id}/architecture-versions", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Versions", archme.archVersionsResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/restore-architecture-version", request: { params: sessionIdParams, ...jsonBody(archme.restoreVersionBody) }, responses: { 200: jsonResponse("Restored", archme.restoreVersionResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/analyze-architecture", request: { params: sessionIdParams, ...jsonBody(archme.analyzeArchBody) }, responses: { 200: jsonResponse("Analysis", archme.analyzeArchResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/validate-empty-repo", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Validation", archme.validateEmptyRepoResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-architecture-diagram", request: { params: sessionIdParams, ...jsonBody(archme.generateArchDiagramBody) }, responses: { 200: jsonResponse("Diagram", archme.generateArchDiagramResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/diagram-image", request: { params: sessionIdParams, ...jsonBody(archme.diagramImageBody) }, responses: { 200: jsonResponse("Image", archme.diagramImageResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/extract-components", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Components", archme.extractComponentsResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-component-code", request: { params: sessionIdParams, ...jsonBody(archme.generateComponentCodeBody) }, responses: { 200: jsonResponse("Code", archme.generateComponentCodeResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/scan-archme-code", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Scan", archme.scanArchMeCodeResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-archme-readme", request: { params: sessionIdParams }, responses: { 200: jsonResponse("README", archme.generateReadmeResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/commit-archme-code", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Committed", archme.commitArchMeResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/regenerate-component", request: { params: sessionIdParams, ...jsonBody(archme.regenerateComponentBody) }, responses: { 200: jsonResponse("Regenerated", archme.regenerateComponentResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/validate-archme-terraform", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Validation", archme.validateArchMeTfResponse) } });

// ── Automation ──────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/generate-automation", request: { params: sessionIdParams, ...jsonBody(automation.generateAutomationBody) }, responses: { 200: jsonResponse("Generated", automation.generateAutomationResponse) } });
registry.registerPath({ method: "post", path: "/api/sessions/{id}/commit-automation", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Committed", automation.commitAutomationResponse) } });

// ── Valuation ───────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/valuation/connect", request: jsonBody(valuation.valuationConnectBody), responses: { 200: jsonResponse("Connected", valuation.valuationConnectResponse) } });
registry.registerPath({ method: "post", path: "/api/valuation/resource-groups", responses: { 200: jsonResponse("Resource groups", valuation.resourceGroupsResponse) } });
registry.registerPath({ method: "post", path: "/api/valuation/scan", request: jsonBody(valuation.valuationScanBody), responses: { 200: jsonResponse("Scanned", valuation.valuationScanResponse) } });
registry.registerPath({ method: "post", path: "/api/valuation/analyze", request: jsonBody(valuation.valuationAnalyzeBody), responses: { 200: jsonResponse("Analysis", valuation.valuationAnalyzeResponse) } });
registry.registerPath({ method: "post", path: "/api/valuation/reserved-instances", responses: { 200: jsonResponse("Recommendations", valuation.reservedInstancesResponse) } });
registry.registerPath({ method: "post", path: "/api/valuation/budget-alerts", responses: { 200: jsonResponse("Alerts", valuation.budgetAlertsResponse) } });
registry.registerPath({ method: "post", path: "/api/valuation/multicloud-compare", responses: { 200: jsonResponse("Comparison", valuation.multicloudCompareResponse) } });

// ── Commit ──────────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/commit", request: { params: sessionIdParams }, responses: { 200: jsonResponse("Committed", commit.commitResponse) } });

// ── Scan ────────────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/scan", request: { params: sessionIdParams, ...jsonBody(scan.scanBody) }, responses: { 200: jsonResponse("Scan results", scan.scanResponse) } });

// ── Fixes ───────────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/fix-issues", request: { params: sessionIdParams, ...jsonBody(fixes.fixIssuesBody) }, responses: { 200: jsonResponse("Fixed", fixes.fixIssuesResponse) } });

// ── Cost Analysis ───────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/sessions/{id}/analyze-cost", request: { params: sessionIdParams, ...jsonBody(costAnalysis.analyzeCostBody) }, responses: { 200: jsonResponse("Cost analysis", costAnalysis.analyzeCostResponse) } });

// ── ScoreMe ─────────────────────────────────────────────────────────────
registry.registerPath({ method: "post", path: "/api/scoreme/run", request: jsonBody(scoreme.scoremeRunBody), responses: { 200: jsonResponse("Report", scoreme.scoremeRunResponse) } });

// ── Activities ──────────────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/checkov/status", responses: { 200: jsonResponse("Status", activities.checkovStatusResponse) } });

// ── Metrics ─────────────────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/metrics/performance", responses: { 200: jsonResponse("Performance", metrics.metricsPerformanceResponse) } });
registry.registerPath({ method: "get", path: "/api/metrics/performance/recent", responses: { 200: jsonResponse("Recent", metrics.metricsRecentResponse) } });
registry.registerPath({ method: "get", path: "/api/metrics/cache", responses: { 200: jsonResponse("Cache", metrics.metricsCacheResponse) } });
registry.registerPath({ method: "get", path: "/api/metrics/ai-usage", responses: { 200: jsonResponse("AI usage", metrics.metricsAiUsageResponse) } });
registry.registerPath({ method: "get", path: "/api/metrics/dashboard", responses: { 200: jsonResponse("Dashboard", metrics.metricsDashboardResponse) } });
registry.registerPath({ method: "post", path: "/api/metrics/reset", responses: { 200: jsonResponse("Reset", metrics.metricsResetResponse) } });
registry.registerPath({ method: "get", path: "/api/metrics/baseline", responses: { 200: jsonResponse("Baseline", metrics.metricsBaselineResponse) } });
registry.registerPath({ method: "get", path: "/api/metrics/feature-flags", responses: { 200: jsonResponse("Flags", metrics.metricsFeatureFlagsResponse) } });

// ── Debug ───────────────────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/debug/azure-mcp", responses: { 200: jsonResponse("Azure MCP", debug.debugAzureMcpResponse) } });
registry.registerPath({ method: "get", path: "/api/debug/terraform-mcp", responses: { 200: jsonResponse("Terraform MCP", debug.debugTerraformMcpResponse) } });
registry.registerPath({ method: "get", path: "/api/debug/credentials", responses: { 200: jsonResponse("Credentials", debug.debugCredentialsResponse) } });
registry.registerPath({ method: "get", path: "/api/debug/tools/{provider}", request: { params: debug.debugToolsParams }, responses: { 200: jsonResponse("Tools", debug.debugToolsResponse) } });

// ── History ─────────────────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/user/history", request: { query: history.historyQuery }, responses: { 200: jsonResponse("History", history.historyResponse) } });

// ── User Secrets ────────────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/user/secrets", responses: { 200: jsonResponse("Secrets config", userSecrets.userSecretsResponse) } });
registry.registerPath({ method: "put", path: "/api/user/secrets/{type}", request: { params: secretTypeParams, ...jsonBody(userSecrets.saveSecretBody) }, responses: { 200: jsonResponse("Saved", userSecrets.saveSecretResponse) } });

// ── User Fix Preferences ────────────────────────────────────────────────
registry.registerPath({ method: "get", path: "/api/users/me/fix-preferences", responses: { 200: jsonResponse("Preferences", userFixPreferences.listPreferencesResponse) } });
registry.registerPath({ method: "get", path: "/api/users/me/fix-preferences/stats", responses: { 200: jsonResponse("Stats", userFixPreferences.preferencesStatsResponse) } });
registry.registerPath({ method: "get", path: "/api/users/me/fix-preferences/top", responses: { 200: jsonResponse("Top", userFixPreferences.topPreferencesResponse) } });
registry.registerPath({ method: "get", path: "/api/users/me/fix-preferences/search", request: { query: userFixPreferences.searchPreferencesQuery }, responses: { 200: jsonResponse("Search results", userFixPreferences.searchPreferencesResponse) } });
registry.registerPath({ method: "post", path: "/api/users/me/fix-preferences", request: jsonBody(userFixPreferences.createPreferenceBody), responses: { 200: jsonResponse("Created", userFixPreferences.createPreferenceResponse) } });
registry.registerPath({ method: "put", path: "/api/users/me/fix-preferences/{id}", request: { params: fileIdParams, ...jsonBody(userFixPreferences.updatePreferenceBody) }, responses: { 200: jsonResponse("Updated", userFixPreferences.updatePreferenceResponse) } });
registry.registerPath({ method: "delete", path: "/api/users/me/fix-preferences/{id}", request: { params: fileIdParams }, responses: { 200: jsonResponse("Deleted", userFixPreferences.deletePreferenceResponse) } });
registry.registerPath({ method: "delete", path: "/api/users/me/fix-preferences", responses: { 200: jsonResponse("Bulk deleted", userFixPreferences.bulkDeleteResponse) } });

// ── Generate the OpenAPI document ───────────────────────────────────────
export function generateOpenAPIDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "AICloudBuilder API",
      version: "2.0.0",
      description: "Spec-Driven API for AICloudBuilder — Terraform, Kubernetes, Docker, ArchMe, and more.",
    },
    servers: [{ url: "http://localhost:9005", description: "Development server" }],
  });
}
