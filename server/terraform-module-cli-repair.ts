/**
 * AI repair after failed terraform init/validate (Terraform module workflow),
 * aligned with MigrateOps repair-from-logs behavior.
 */
import { storage } from "./storage";
import { openaiService } from "./openai-service";
import { ensureVariablesTfFromMainTf } from "./terraform-variable-sync";
import {
  runTerraformWorkspaceValidation,
  isTerraformWorkspaceFile,
  type TerraformCliValidationResult,
} from "./terraform-cli-validate";
import { fileBasenameKey } from "./utils/generated-files-dedupe";
import type { Session } from "@shared/schema";
import { validateStandaloneRootMainTf } from "./terraform-standalone-root-validation";

function isCliRepairDisabled(): boolean {
  return process.env.TERRAFORM_CLI_REPAIR === "0" || process.env.TERRAFORM_CLI_REPAIR === "false";
}

export async function persistRepairedTerraformFiles(
  sessionId: string,
  repaired: Array<{ path: string; content: string }>,
): Promise<void> {
  const existing = await storage.getFilesBySession(sessionId);

  for (const r of repaired) {
    const key = fileBasenameKey(r.path);
    const match = existing.find((f) => fileBasenameKey(f.fileName) === key);
    if (match) {
      await storage.updateFile(match.id, r.content);
    } else {
      await storage.createFile({
        sessionId,
        fileName: r.path.replace(/^\/+/, ""),
        content: r.content,
      });
    }
  }
}

/**
 * Runs AI repair + variable sync + re-validate. Returns updated check and whether validate passed.
 */
export async function repairSessionTerraformAfterCliFailure(
  sessionId: string,
  userDescription: string,
  session: Session,
  failedCheck: TerraformCliValidationResult,
): Promise<{ check: TerraformCliValidationResult; succeeded: boolean }> {
  if (isCliRepairDisabled()) {
    return { check: failedCheck, succeeded: false };
  }

  const allFiles = await storage.getFilesBySession(sessionId);
  const bundle = allFiles
    .filter((f) => isTerraformWorkspaceFile(f.fileName))
    .map((f) => ({ path: f.fileName, content: f.content }));

  if (bundle.length === 0) {
    return { check: failedCheck, succeeded: false };
  }

  let repaired = await openaiService.repairTerraformModuleFilesFromValidateOutput(bundle, {
    cloudProvider: session.cloudProvider,
    moduleApproach: session.moduleApproach,
    failedCheck,
  });

  if (session.moduleApproach === "standalone-root") {
    const mainIdx = repaired.findIndex((f) => f.path.toLowerCase().endsWith("main.tf"));
    if (mainIdx >= 0) {
      const violation = validateStandaloneRootMainTf(repaired[mainIdx].content);
      if (violation) {
        console.warn(`[Terraform module] Repair would violate standalone root rules: ${violation}`);
      }
    }
  }

  await persistRepairedTerraformFiles(sessionId, repaired);
  await ensureVariablesTfFromMainTf(sessionId, userDescription);

  const recheckFiles = await storage.getFilesBySession(sessionId);
  const check = await runTerraformWorkspaceValidation(
    recheckFiles.map((f) => ({ fileName: f.fileName, content: f.content })),
  );

  return { check, succeeded: check.validateOk === true };
}

export function shouldAttemptTerraformCliRepair(check: TerraformCliValidationResult): boolean {
  if (isCliRepairDisabled()) return false;
  if (!check.ran) return false;
  if (check.skippedReason) return false;
  if (check.validateOk) return false;
  return true;
}

/** AI repair using GitHub Actions plan/validate logs (CI/CD card “Review and Fix”). */
export async function repairSessionTerraformFromCiPlanLogs(
  sessionId: string,
  userDescription: string,
  session: Session,
  planLogs: string,
): Promise<void> {
  if (!planLogs.trim()) {
    throw new Error("planLogs is required");
  }
  const allFiles = await storage.getFilesBySession(sessionId);
  const bundle = allFiles
    .filter((f) => isTerraformWorkspaceFile(f.fileName))
    .map((f) => ({ path: f.fileName, content: f.content }));
  if (bundle.length === 0) {
    throw new Error("No Terraform files in session");
  }

  const repaired = await openaiService.repairTerraformModuleFromCiPlanLogs(bundle, {
    cloudProvider: session.cloudProvider,
    moduleApproach: session.moduleApproach,
    planLogs,
  });

  await persistRepairedTerraformFiles(sessionId, repaired);
  await ensureVariablesTfFromMainTf(sessionId, userDescription);
}
