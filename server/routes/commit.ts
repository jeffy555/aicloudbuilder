/**
 * Generic commit routes
 * Handles committing files to repositories (shared across modules)
 */

import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { openaiService } from "../openai-service";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { sessionIdParams } from "@shared/api-contracts/common";
import { resolveRepositoryCredentials } from "../utils/credentials";
import { bitwardenService } from "../services/bitwarden-service";
import {
  isTerraformRootModuleCicdSession,
  preserveSessionFilesAfterTerraformRootCommit,
  TERRAFORM_MODULE_VALIDATE_WORKFLOW,
} from "../terraform-module-cicd.js";
import { TERRAFORM_GENERATOR_METADATA_FILENAME } from "../terraform-generator-metadata";

function isMigrateOpsSession(session: any): boolean {
  return Boolean(
    session?.activeModule === 'migrateops' ||
    session?.selectedResourceGroups ||
    session?.scannedResources
  );
}

/** MigrateOps needs session file storage after commit for CI repair → re-commit without relying on stale React state. */
function preserveSessionFilesAfterMigrateOpsCommit(session: any): boolean {
  return session?.activeModule === 'migrateops';
}

function buildGithubMigrateOpsWorkflows(): Array<{ path: string; content: string }> {
  const validateWorkflow = `name: MigrateOps Validate Migration

on:
  push:
    branches: [main, master]
    paths:
      - '**.tf'
      - '**.tfvars'
      - 'imports.tf'
      - '.github/workflows/**'
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  validate-migration:
    name: Validate the Migration
    runs-on: ubuntu-latest
    env:
      TF_IN_AUTOMATION: "true"
      AZURE_CLIENT_ID: \${{ secrets.AZURE_CLIENT_ID || '' }}
      AZURE_CLIENT_SECRET: \${{ secrets.AZURE_CLIENT_SECRET || '' }}
      AZURE_TENANT_ID: \${{ secrets.AZURE_TENANT_ID || '' }}
      AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID || '' }}
      AZURE_CREDENTIALS: \${{ secrets.AZURE_CREDENTIALS || '' }}
      ARM_CLIENT_ID: \${{ secrets.ARM_CLIENT_ID || '' }}
      ARM_CLIENT_SECRET: \${{ secrets.ARM_CLIENT_SECRET || '' }}
      ARM_TENANT_ID: \${{ secrets.ARM_TENANT_ID || '' }}
      ARM_SUBSCRIPTION_ID: \${{ secrets.ARM_SUBSCRIPTION_ID || '' }}
    defaults:
      run:
        shell: bash
        working-directory: .
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false

      - name: Azure Login (optional)
        if: \${{ env.AZURE_CREDENTIALS != '' }}
        uses: azure/login@v2
        with:
          creds: \${{ env.AZURE_CREDENTIALS }}

      - name: Terraform Init
        run: terraform init -input=false

      # Terraform Validate (disabled temporarily — re-enable when ready)
      # - name: Terraform Validate
      #   run: terraform validate -no-color

      - name: Terraform Plan
        id: plan
        run: |
          set +e
          terraform plan -input=false -out=tfplan -detailed-exitcode
          exit_code=$?
          set -e
          if [ "$exit_code" -eq 1 ]; then
            echo "Terraform plan failed"
            exit 1
          fi
          echo "exit_code=$exit_code" >> "$GITHUB_OUTPUT"

      - name: Export plan summary
        run: |
          terraform show -json tfplan > tfplan.json
          jq '{
            add: ([.resource_changes[]? | select(.change.actions | index("create"))] | length),
            change: ([.resource_changes[]? | select(.change.actions | index("update"))] | length),
            destroy: ([.resource_changes[]? | select(.change.actions | index("delete"))] | length)
          }' tfplan.json > plan-summary.json
          echo "Plan summary:" >> "$GITHUB_STEP_SUMMARY"
          cat plan-summary.json >> "$GITHUB_STEP_SUMMARY"

      - name: Upload tfplan artifact
        uses: actions/upload-artifact@v4
        with:
          name: migrateops-plan-artifacts
          path: |
            ./tfplan
            ./tfplan.json
            ./plan-summary.json
          if-no-files-found: error

      - name: Summary
        run: |
          if [ "\${{ steps.plan.outputs.exit_code }}" = "0" ]; then
            echo "No infrastructure drift detected." >> "$GITHUB_STEP_SUMMARY"
          else
            echo "Terraform plan completed with pending changes." >> "$GITHUB_STEP_SUMMARY"
          fi
`;

  const applyWorkflow = `name: MigrateOps Apply Migration

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  validate-migration:
    name: Validate the Migration
    runs-on: ubuntu-latest
    env:
      TF_IN_AUTOMATION: "true"
      AZURE_CLIENT_ID: \${{ secrets.AZURE_CLIENT_ID || '' }}
      AZURE_CLIENT_SECRET: \${{ secrets.AZURE_CLIENT_SECRET || '' }}
      AZURE_TENANT_ID: \${{ secrets.AZURE_TENANT_ID || '' }}
      AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID || '' }}
      AZURE_CREDENTIALS: \${{ secrets.AZURE_CREDENTIALS || '' }}
      ARM_CLIENT_ID: \${{ secrets.ARM_CLIENT_ID || '' }}
      ARM_CLIENT_SECRET: \${{ secrets.ARM_CLIENT_SECRET || '' }}
      ARM_TENANT_ID: \${{ secrets.ARM_TENANT_ID || '' }}
      ARM_SUBSCRIPTION_ID: \${{ secrets.ARM_SUBSCRIPTION_ID || '' }}
    defaults:
      run:
        shell: bash
        working-directory: .
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false

      - name: Azure Login (optional)
        if: \${{ env.AZURE_CREDENTIALS != '' }}
        uses: azure/login@v2
        with:
          creds: \${{ env.AZURE_CREDENTIALS }}

      - name: Terraform Init
        run: terraform init -input=false

      # Terraform Validate (disabled temporarily — re-enable when ready)
      # - name: Terraform Validate
      #   run: terraform validate -no-color

      - name: Terraform Plan
        run: terraform plan -input=false -out=tfplan

      - name: Export plan summary
        run: |
          terraform show -json tfplan > tfplan.json
          jq '{
            add: ([.resource_changes[]? | select(.change.actions | index("create"))] | length),
            change: ([.resource_changes[]? | select(.change.actions | index("update"))] | length),
            destroy: ([.resource_changes[]? | select(.change.actions | index("delete"))] | length)
          }' tfplan.json > plan-summary.json
          echo "Plan summary:" >> "$GITHUB_STEP_SUMMARY"
          cat plan-summary.json >> "$GITHUB_STEP_SUMMARY"

      - name: Upload tfplan artifact
        uses: actions/upload-artifact@v4
        with:
          name: migrateops-plan-artifacts
          path: |
            ./tfplan
            ./tfplan.json
            ./plan-summary.json
          if-no-files-found: error

  apply-migration:
    name: Apply Migration (Approval Required)
    needs: validate-migration
    runs-on: ubuntu-latest
    environment: migrateops-apply
    env:
      TF_IN_AUTOMATION: "true"
      AZURE_CLIENT_ID: \${{ secrets.AZURE_CLIENT_ID || '' }}
      AZURE_CLIENT_SECRET: \${{ secrets.AZURE_CLIENT_SECRET || '' }}
      AZURE_TENANT_ID: \${{ secrets.AZURE_TENANT_ID || '' }}
      AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID || '' }}
      AZURE_CREDENTIALS: \${{ secrets.AZURE_CREDENTIALS || '' }}
      ARM_CLIENT_ID: \${{ secrets.ARM_CLIENT_ID || '' }}
      ARM_CLIENT_SECRET: \${{ secrets.ARM_CLIENT_SECRET || '' }}
      ARM_TENANT_ID: \${{ secrets.ARM_TENANT_ID || '' }}
      ARM_SUBSCRIPTION_ID: \${{ secrets.ARM_SUBSCRIPTION_ID || '' }}
    defaults:
      run:
        shell: bash
        working-directory: .
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false

      - name: Azure Login (optional)
        if: \${{ env.AZURE_CREDENTIALS != '' }}
        uses: azure/login@v2
        with:
          creds: \${{ env.AZURE_CREDENTIALS }}

      - name: Download tfplan artifact
        uses: actions/download-artifact@v4
        with:
          name: migrateops-plan-artifacts
          path: .

      - name: Terraform Init
        run: terraform init -input=false

      - name: Terraform Apply
        run: terraform apply -input=false -auto-approve tfplan
`;

  return [
    { path: '.github/workflows/migrateops-validate.yml', content: validateWorkflow },
    { path: '.github/workflows/migrateops-apply.yml', content: applyWorkflow },
  ];
}

/** Terraform root module (standalone / aggregated): same jobs as MigrateOps, distinct workflow files. */
function buildGithubTerraformModuleWorkflows(): Array<{ path: string; content: string }> {
  const base = buildGithubMigrateOpsWorkflows();
  return base.map(({ path, content }) => {
    const c = content
      .replace(/MigrateOps Validate Migration/g, "Terraform Module Validate")
      .replace(/MigrateOps Apply Migration/g, "Terraform Module Apply")
      .replace(/migrateops-plan-artifacts/g, "terraform-module-plan-artifacts")
      .replace(/environment: migrateops-apply/g, "environment: terraform-module-apply")
      .replace(/Validate the Migration/g, "Validate Terraform");
    const newPath = path
      .replace("migrateops-validate.yml", "terraform-module-validate.yml")
      .replace("migrateops-apply.yml", "terraform-module-apply.yml");
    return { path: newPath, content: c };
  });
}

function buildAzureDevOpsMigratePipeline(): { path: string; content: string } {
  const pipeline = `trigger:
  branches:
    include:
      - main

pr:
  branches:
    include:
      - main

variables:
  TF_IN_AUTOMATION: "true"

stages:
  - stage: ValidateMigration
    displayName: Validate the Migration
    jobs:
      - job: TerraformPlan
        displayName: Terraform Init and Plan
        pool:
          vmImage: ubuntu-latest
        steps:
          - checkout: self

          - task: TerraformInstaller@1
            displayName: Install Terraform
            inputs:
              terraformVersion: latest

          - script: terraform init -input=false
            displayName: Terraform Init

          - script: terraform plan -input=false -out=tfplan
            displayName: Terraform Plan

          - publish: tfplan
            artifact: tfplan
            displayName: Publish tfplan artifact

  - stage: AwaitApproval
    displayName: Approval Gate
    dependsOn: ValidateMigration
    jobs:
      - job: ManualApproval
        displayName: Manual Approval Before Apply
        pool: server
        timeoutInMinutes: 1440
        steps:
          - task: ManualValidation@0
            timeoutInMinutes: 1440
            inputs:
              instructions: 'Review tfplan artifact and approve only if migration is safe.'
              onTimeout: 'reject'

  - stage: ApplyMigration
    displayName: Apply Migration
    dependsOn: AwaitApproval
    condition: succeeded('AwaitApproval')
    jobs:
      - job: TerraformApply
        displayName: Terraform Apply
        pool:
          vmImage: ubuntu-latest
        steps:
          - checkout: self

          - task: TerraformInstaller@1
            displayName: Install Terraform
            inputs:
              terraformVersion: latest

          - download: current
            artifact: tfplan

          - script: terraform init -input=false
            displayName: Terraform Init

          - script: terraform apply -input=false -auto-approve $(Pipeline.Workspace)/tfplan/tfplan
            displayName: Terraform Apply
`;

  return { path: 'azure-pipelines.yml', content: pipeline };
}

function buildProviderSpecificMigrateCi(provider: MCPProvider): Array<{ path: string; content: string }> {
  if (provider === 'github') {
    return buildGithubMigrateOpsWorkflows();
  }
  if (provider === 'azure') {
    return [buildAzureDevOpsMigratePipeline()];
  }
  return [];
}

async function syncAzureSecretsForMigrateOpsWorkflow(
  userId: string,
  repoIdentifier: string,
  credentials: any
): Promise<{ synced: string[] }> {
  let azureSecret: Record<string, string> | null = null;
  try {
    azureSecret = await bitwardenService.getUserSecret(userId, 'azure-cloud');
  } catch {
    // If Bitwarden is temporarily unavailable, env fallback is used.
  }

  const clientId = azureSecret?.clientId || process.env.AZURE_CLIENT_ID || '';
  const clientSecret = azureSecret?.clientSecret || process.env.AZURE_CLIENT_SECRET || '';
  const tenantId = azureSecret?.tenantId || process.env.AZURE_TENANT_ID || '';
  const subscriptionId = azureSecret?.subscriptionId || process.env.AZURE_SUBSCRIPTION_ID || '';

  if (!clientId || !clientSecret || !tenantId || !subscriptionId) {
    throw new Error(
      'Azure credentials missing. Save azure-cloud in Bitwarden (clientId, clientSecret, tenantId, subscriptionId).'
    );
  }

  return await mcpClient.syncGitHubRepositorySecrets(
    repoIdentifier,
    {
      AZURE_CLIENT_ID: clientId,
      AZURE_CLIENT_SECRET: clientSecret,
      AZURE_TENANT_ID: tenantId,
      AZURE_SUBSCRIPTION_ID: subscriptionId,
      AZURE_CREDENTIALS: JSON.stringify({
        clientId,
        clientSecret,
        tenantId,
        subscriptionId,
      }),
      ARM_CLIENT_ID: clientId,
      ARM_CLIENT_SECRET: clientSecret,
      ARM_TENANT_ID: tenantId,
      ARM_SUBSCRIPTION_ID: subscriptionId,
    },
    credentials
  );
}

/**
 * Register commit routes
 */
export function registerCommitRoutes(app: Express) {
  // Generic commit endpoint (for Terraform files)
  app.post("/api/sessions/:id/commit", optionalAuth, validateRequest({ params: sessionIdParams }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;
    let session: any = null;

    try {
      session = await storage.getSession(sessionId);
      const { credentials } = await resolveRepositoryCredentials(session?.provider as MCPProvider, req.userId);
      let repoIdentifier = session?.repositoryName || session?.repositoryId;

      if (session?.provider === 'github') {
        // For GitHub, repository ID (numeric) is not a valid repo slug for REST writes.
        // Resolve ID -> repo name/full_name when needed.
        const looksLikeNumericId = repoIdentifier && /^\d+$/.test(String(repoIdentifier));
        if (looksLikeNumericId) {
          try {
            const repos = await mcpClient.listRepositories('github', credentials);
            const match = repos.find((r: any) => String(r.id) === String(repoIdentifier));
            if (match?.full_name) {
              repoIdentifier = match.full_name;
            } else if (match?.name) {
              repoIdentifier = match.name;
            }
          } catch (resolveError: any) {
            console.warn(`⚠️  Could not resolve GitHub repository ID ${repoIdentifier} to name: ${resolveError?.message || resolveError}`);
          }
        }
      }

      if (!session || !session.provider || !repoIdentifier) {
        return res.status(400).json({ error: 'Session not properly configured' });
      }
      if (!session.userId || session.userId !== req.userId) {
        console.warn(`[SECURITY] Commit session access denied: sessionId=${sessionId} sessionOwner=${session.userId} requesterId=${req.userId ?? 'anonymous'} ip=${req.ip}`);
        return res.status(403).json({ error: 'Access denied to this session' });
      }
      // Get files from session storage (where generated files are stored)
      console.log(`\n📁 Getting files from session storage for commit...`);
      const files = await storage.getFilesBySession(sessionId);
      
      console.log(`✅ Found ${files.length} file(s) in session storage`);
      
      if (files.length === 0) {
        return res.status(400).json({ 
          error: 'No files found to commit',
          details: 'No files have been generated for this session yet. Please generate Terraform files first.'
        });
      }
      
      // Filter to Terraform files + AICloudBuilder generator metadata (root marker file)
      const terraformFiles = files.filter((file) => {
        const fileName = file.fileName.toLowerCase();
        return (
          fileName.endsWith(".tf") ||
          fileName.endsWith(".tfvars") ||
          fileName === ".aicloudbuilder.json"
        );
      });
      
      console.log(`📄 Terraform files to commit: ${terraformFiles.length}`);
      terraformFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} chars)`);
      });
      
      if (terraformFiles.length === 0) {
        return res.status(400).json({ 
          error: 'No Terraform files found to commit',
          details: 'No Terraform files (.tf or .tfvars) found in session or repository'
        });
      }
      
      // Generate commit message based on file contents
      const commitMessage = await openaiService.generateCommitMessage(
        terraformFiles.map(f => ({ name: f.fileName, content: f.content }))
      );

      // MigrateOps / Terraform root module: add provider-specific CI/CD workflow files at commit time.
      let pipelineFiles: Array<{ path: string; content: string }> = [];
      if (isMigrateOpsSession(session)) {
        pipelineFiles = buildProviderSpecificMigrateCi(session.provider as MCPProvider);
      } else if (isTerraformRootModuleCicdSession(session) && session.provider === "github") {
        pipelineFiles = buildGithubTerraformModuleWorkflows();
      }
      if (pipelineFiles.length > 0) {
        console.log(`⚙️  Added ${pipelineFiles.length} provider-specific pipeline file(s) for ${session.provider}`);
        pipelineFiles.forEach((f) => console.log(`   - ${f.path}`));
      }

      const filesToCommit = [
        ...terraformFiles.map(f => ({ path: f.fileName, content: f.content })),
        ...pipelineFiles,
      ];

      const body = req.body as { branchName?: string; commitMessage?: string } | undefined;
      const preferredBranch =
        (body?.branchName && String(body.branchName).trim()) ||
        (session.repositoryBranch && String(session.repositoryBranch).trim()) ||
        undefined;

      // Commit via MCP
      const result = await mcpClient.commitFiles(
        session.provider as MCPProvider,
        repoIdentifier,
        filesToCommit,
        commitMessage,
        credentials,
        preferredBranch || null
      );

      const validateWorkflowFileName = isMigrateOpsSession(session)
        ? "migrateops-validate.yml"
        : isTerraformRootModuleCicdSession(session)
          ? TERRAFORM_MODULE_VALIDATE_WORKFLOW
          : null;

      let cicd: any = null;
      if (validateWorkflowFileName && session.provider === "github") {
        try {
          const skippedWorkflowFiles: string[] = result?.skippedWorkflowFiles || [];
          const validateWorkflowPath = `.github/workflows/${validateWorkflowFileName}`;
          const validateWorkflowSkipped = skippedWorkflowFiles.includes(validateWorkflowPath);
          if (validateWorkflowSkipped) {
            cicd = {
              provider: "github",
              validateWorkflowTriggered: false,
              status: "workflow_missing",
              error:
                "Validate workflow file was not committed (missing GitHub workflow token scope).",
            };
            console.warn(
              `[CI] Validate workflow YAML was not pushed (${validateWorkflowPath}). Terraform commit still succeeded.`
            );
          } else {
            const azureSecretSync = await syncAzureSecretsForMigrateOpsWorkflow(
              req.userId!,
              repoIdentifier,
              credentials
            );

            const branch = result.branch || session.repositoryBranch || "main";

            const pushedSha = String(
              result?.commitSha || result?.commit?.sha || result?.sha || ""
            ).trim();

            let latestRun: any | null = null;
            if (pushedSha) {
              latestRun = await mcpClient.getWorkflowRunForHeadCommit(
                repoIdentifier,
                validateWorkflowFileName,
                branch,
                pushedSha,
                credentials,
                { maxAttempts: 22, delayMs: 450 }
              );
              if (!latestRun) {
                const cand = await mcpClient.getLatestGitHubWorkflowRun(
                  repoIdentifier,
                  validateWorkflowFileName,
                  branch,
                  credentials
                );
                if (cand?.head_sha === pushedSha) latestRun = cand;
              }
            } else {
              for (let i = 0; i < 5; i++) {
                latestRun = await mcpClient.getLatestGitHubWorkflowRun(
                  repoIdentifier,
                  validateWorkflowFileName,
                  branch,
                  credentials
                );
                if (latestRun) break;
                await new Promise((r) => setTimeout(r, 1000));
              }
            }

            cicd = {
              provider: "github",
              validateWorkflowTriggered: true,
              workflowFile: validateWorkflowPath,
              branch,
              commitSha: pushedSha || null,
              runId: latestRun?.id || null,
              runUrl: latestRun?.html_url || null,
              status: latestRun?.status || (pushedSha ? "queued" : "unknown"),
              secretSync: azureSecretSync,
            };
          }
        } catch (workflowError: any) {
          console.warn(
            "⚠️  Could not auto-trigger GitHub validate workflow:",
            workflowError?.message || workflowError
          );
          if (!cicd) {
            cicd = {
              provider: "github",
              validateWorkflowTriggered: false,
              error: workflowError?.message || "Failed to trigger validate workflow",
            };
          }
        }
      }

      const preserveWorkspace =
        preserveSessionFilesAfterMigrateOpsCommit(session) ||
        preserveSessionFilesAfterTerraformRootCommit(session);

      if (preserveWorkspace) {
        console.log(
          `\n[CI] Keeping session Terraform files after commit (re-commit / validation loop).`
        );
      } else {
        // Clear session data after successful commit to allow fresh start (other modules)
        console.log(`\n🧹 Clearing session data after successful commit...`);
        console.log(`   This allows starting fresh for the next workflow`);

        await storage.deleteFilesBySession(sessionId);
        console.log(`   ✅ Cleared ${terraformFiles.length} file(s) from session storage`);

        await storage.updateSession(sessionId, {
          currentStep: '1',
          workflowStep: undefined,
        });
        console.log(`   ✅ Reset session state (currentStep: 1)`);
        console.log(`   ✅ Session is now ready for a fresh start`);
      }

      res.json({
        success: true,
        commitMessage,
        result,
        commitSha: result.commitSha || result.commit?.sha || result.sha,
        branch: result.branch || 'main',
        filesCommitted: filesToCommit.length,
        pipelineFilesGenerated: pipelineFiles.map((f) => f.path),
        skippedWorkflowFiles: result?.skippedWorkflowFiles || [],
        cicd,
        sessionReset: !preserveWorkspace,
        message:
          (result?.skippedWorkflowFiles?.length || 0) > 0
            ? `Core files committed. ${result.skippedWorkflowFiles.length} workflow file(s) skipped due to GitHub token workflow permissions.`
            : preserveWorkspace
              ? 'Files committed successfully. Workspace kept so you can fix from CI logs and push again.'
              : 'Files committed successfully. Session cleared and ready for a fresh start.',
      });
    } catch (error: any) {
      console.error('\n❌ ========== COMMIT ERROR ==========');
      console.error('Error committing files:', error);
      console.error('Error message:', error?.message);
      console.error('Error code:', error?.code);
      console.error('Error data:', error?.data);
      console.error('Error stack:', error?.stack);
      console.error('Session ID:', sessionId);
      console.error('Provider:', session?.provider);
      console.error('Repository:', session?.repositoryName);
      console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      console.error('=====================================\n');
      
      const errorMessage = error?.message || 'Failed to commit files';
      
      // Extract more details from the error
      const errorDetails: any = {
        message: errorMessage,
        code: error?.code,
        data: error?.data,
        stack: error?.stack,
        sessionId,
        provider: session?.provider,
        repository: session?.repositoryName,
        errorType: error?.constructor?.name || typeof error
      };
      
      // Check if error is from MCP and includes "not found"
      if (errorMessage.includes('MCP error') && errorMessage.includes('Not Found')) {
        console.error('⚠️  MCP error occurred - "Resource not found"');
        console.error('   This typically means:');
        console.error('   1. Repository branch doesn\'t exist (empty repo)');
        console.error('   2. Repository path/name is incorrect');
        console.error('   3. GitHub MCP server internal issue');
        errorDetails.suggestedFix = 'Check if repository is empty or branch name is correct';
      }
      
      res.status(500).json({ 
        error: errorMessage,
        details: errorDetails
      });
    }
  });
}

