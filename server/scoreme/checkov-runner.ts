import { exec } from "child_process";
import { promisify } from "util";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";

const execAsync = promisify(exec);

export interface CheckovRunResult {
  passed: number;
  failed: number;
  skipped: number;
  checks: Array<{
    checkId: string;
    checkName: string;
    file: string;
    resource: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    message: string;
    guideline?: string;
  }>;
}

const severityMap: Record<string, CheckovRunResult["checks"][number]["severity"]> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info",
};

async function runCheckovCommand(framework: string, tempDir: string): Promise<string> {
  const isWindows = process.platform === "win32";
  const baseArgs = ["-d", tempDir, "--framework", framework, "--output", "json", "--compact", "--quiet"];
  const commands: [string, string[]][] = isWindows
    ? [
        ["checkov", baseArgs],
        ["py", ["-m", "uv", "run", "checkov", ...baseArgs]],
        ["py", ["-m", "checkov", ...baseArgs]],
      ]
    : [
        ["checkov", baseArgs],
        ["python3", ["-m", "uv", "run", "checkov", ...baseArgs]],
        ["python3", ["-m", "checkov", ...baseArgs]],
        ["python", ["-m", "checkov", ...baseArgs]],
      ];

  let lastError: Error | null = null;
  for (const [command, args] of commands) {
    try {
      const { stdout, stderr } = await execAsync(`${command} ${args.join(" ")}`, {
        timeout: 120000,
        cwd: tempDir,
      });
      return stdout || stderr;
    } catch (error: any) {
      if (error.stdout || error.stderr) {
        return error.stdout || error.stderr;
      }
      lastError = error;
    }
  }

  throw lastError || new Error("All Checkov commands failed");
}

function parseCheckovJson(raw: string): CheckovRunResult {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Checkov output did not contain JSON");
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const summary = parsed.summary || {};
  const results = parsed.results || {};

  const passed = Number(summary.passed ?? parsed.results?.passed_checks?.length ?? 0);
  const failed = Number(summary.failed ?? parsed.results?.failed_checks?.length ?? 0);
  const skipped = Number(summary.skipped ?? parsed.results?.skipped_checks?.length ?? 0);

  const failedChecks = Array.isArray(results.failed_checks) ? results.failed_checks : [];
  const checks = failedChecks.map((check: any) => {
    const reason =
      check.check_result?.failure_reason ||
      check.check_result?.error_message ||
      check.message ||
      `${check.check_name || check.check_id} failed`;

    return {
      checkId: check.check_id || "",
      checkName: check.check_name || "",
      file: check.file_path || check.file_path || "",
      resource: check.resource || "",
      severity: severityMap[(check.severity || "MEDIUM").toUpperCase()] || "medium",
      message: reason,
      guideline: check.guideline || check.check_result?.guideline || "",
    };
  });

  return {
    passed,
    failed,
    skipped,
    checks,
  };
}

export async function runCheckovOnFiles(
  framework: "terraform" | "kubernetes" | "dockerfile",
  files: Array<{ path: string; content: string }>
): Promise<CheckovRunResult> {
  if (files.length === 0) {
    return {
      passed: 0,
      failed: 0,
      skipped: 0,
      checks: [],
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), `scoreme-${framework}-`));
  try {
    for (const file of files) {
      const filePath = join(tempDir, file.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf-8");
    }

    const output = await runCheckovCommand(framework, tempDir);
    return parseCheckovJson(output);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

