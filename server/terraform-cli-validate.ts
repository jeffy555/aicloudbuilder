/**
 * Runs terraform init (-backend=false) + terraform validate in a temp directory.
 * Mirrors CI: catches schema/syntax/consistency issues before terraform plan.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

export type TerraformValidateDiagnostic = {
  severity: string;
  summary: string;
  detail?: string;
  range?: { filename?: string; start?: { line: number } };
};

export type TerraformCliValidationResult = {
  ran: boolean;
  skippedReason?: string;
  initOk: boolean;
  initStdout?: string;
  initStderr?: string;
  validateOk: boolean;
  diagnostics: TerraformValidateDiagnostic[];
  validateRaw?: string;
};

function isTerraformCliDisabled(): boolean {
  return process.env.TERRAFORM_CLI_CHECK === "0" || process.env.TERRAFORM_CLI_CHECK === "false";
}

/** Root + nested paths (e.g. AppService/main.tf for aggregated child copies). */
export function isTerraformWorkspaceFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower === "readme.md") return false;
  return lower.endsWith(".tf") || lower.endsWith(".tfvars");
}

/**
 * @param files — session files (fileName + content)
 */
export async function runTerraformWorkspaceValidation(
  files: Array<{ fileName: string; content: string }>,
): Promise<TerraformCliValidationResult> {
  const empty: TerraformCliValidationResult = {
    ran: false,
    initOk: false,
    validateOk: false,
    diagnostics: [],
  };

  if (isTerraformCliDisabled()) {
    return { ...empty, skippedReason: "TERRAFORM_CLI_CHECK=0" };
  }

  const tfFiles = files.filter((f) => isTerraformWorkspaceFile(f.fileName));
  if (tfFiles.length === 0) {
    return { ...empty, skippedReason: "no .tf or .tfvars files" };
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "tf-cli-validate-"));
  try {
    for (const f of tfFiles) {
      const rel = f.fileName.replace(/^\/+/, "");
      const target = join(tmpDir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content, "utf8");
    }

    let initOk = false;
    let initStdout = "";
    let initStderr = "";
    try {
      const init = await execFileAsync(
        "terraform",
        ["init", "-backend=false", "-input=false", "-no-color"],
        { cwd: tmpDir, maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
      );
      initStdout = init.stdout?.toString() ?? "";
      initStderr = init.stderr?.toString() ?? "";
      initOk = true;
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; code?: string; message?: string };
      initStdout = err.stdout?.toString() ?? "";
      initStderr = err.stderr?.toString() ?? "";
      const msg = `${err.message ?? ""} ${initStderr} ${initStdout}`;
      if (err.code === "ENOENT" || /terraform.*not found|spawn.*terraform/i.test(msg)) {
        return {
          ...empty,
          skippedReason: "terraform CLI not found in PATH",
        };
      }
      return {
        ran: true,
        initOk: false,
        initStdout,
        initStderr,
        validateOk: false,
        diagnostics: [
          {
            severity: "error",
            summary: "terraform init failed (provider install or config)",
            detail: (initStderr || initStdout || String(e)).slice(0, 8000),
          },
        ],
      };
    }

    let validateRaw = "";
    try {
      const v = await execFileAsync(
        "terraform",
        ["validate", "-json", "-no-color"],
        { cwd: tmpDir, maxBuffer: 20 * 1024 * 1024, timeout: 60_000 },
      );
      validateRaw = v.stdout?.toString() ?? "";
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      validateRaw = err.stdout?.toString() || err.stderr?.toString() || "";
    }

    let validateOk = false;
    const diagnostics: TerraformValidateDiagnostic[] = [];
    try {
      const parsed = JSON.parse(validateRaw) as {
        valid?: boolean;
        error_count?: number;
        diagnostics?: TerraformValidateDiagnostic[];
      };
      if (parsed.diagnostics && Array.isArray(parsed.diagnostics)) {
        diagnostics.push(...parsed.diagnostics);
      }
      validateOk = parsed.valid === true && (parsed.error_count ?? 0) === 0;
    } catch {
      if (validateRaw.trim()) {
        diagnostics.push({
          severity: "error",
          summary: "terraform validate failed (unparseable output)",
          detail: validateRaw.slice(0, 8000),
        });
      }
      validateOk = false;
    }

    return {
      ran: true,
      initOk: true,
      initStdout,
      initStderr,
      validateOk,
      diagnostics,
      validateRaw: validateRaw.length > 2000 ? validateRaw.slice(0, 2000) + "…" : validateRaw,
    };
  } catch (outer: unknown) {
    const msg = outer instanceof Error ? outer.message : String(outer);
    return {
      ran: false,
      skippedReason: msg,
      initOk: false,
      validateOk: false,
      diagnostics: [],
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
