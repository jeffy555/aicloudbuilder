export type CheckovSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface CheckovCheck {
  checkId: string;
  checkName: string;
  severity: CheckovSeverity;
  file: string;
  message: string;
  guideline?: string;
}

export interface CheckovRunResult {
  checks: CheckovCheck[];
  passed: number;
  failed: number;
  skipped: number;
}

export async function runCheckovOnFiles(
  type: "terraform" | "kubernetes" | "dockerfile",
  files: Array<{ path: string; content: string }>
): Promise<CheckovRunResult> {
  const checks: CheckovCheck[] = [];

  for (const file of files) {
    if (type === "terraform") {
      if (/allow_public_access\s*=\s*true/i.test(file.content)) {
        checks.push({
          checkId: "CKV_TERRAFORM_1",
          checkName: "Public access is enabled",
          severity: "high",
          file: file.path,
          message: "Terraform resource exposes storage with public access enabled.",
          guideline: "Disable public access and restrict to private networks.",
        });
      }
      if (!/tags\s*=\s*{/.test(file.content)) {
        checks.push({
          checkId: "CKV_TERRAFORM_2",
          checkName: "Tags missing",
          severity: "low",
          file: file.path,
          message: "Resource lacks tagging metadata.",
          guideline: "Add tags for cost tracking and ownership.",
        });
      }
    } else if (type === "kubernetes") {
      if (!/readinessProbe:/i.test(file.content)) {
        checks.push({
          checkId: "CKV_K8S_1",
          checkName: "Readiness probe missing",
          severity: "medium",
          file: file.path,
          message: "Kubernetes manifest does not define a readiness probe.",
          guideline: "Add readinessProbe to ensure traffic goes to ready pods.",
        });
      }
      if (/hostNetwork:\s*true/.test(file.content)) {
        checks.push({
          checkId: "CKV_K8S_2",
          checkName: "hostNetwork enabled",
          severity: "medium",
          file: file.path,
          message: "hostNetwork=true increases security risk.",
        });
      }
    } else if (type === "dockerfile") {
      if (/FROM\s+(\S+):latest/i.test(file.content)) {
        checks.push({
          checkId: "CKV_DOCKER_1",
          checkName: "Using latest tag",
          severity: "medium",
          file: file.path,
          message: "Dockerfile uses :latest, which is not deterministic.",
          guideline: "Pin to a specific version for reproducible builds.",
        });
      }
      if (!/USER\s+\w+/i.test(file.content)) {
        checks.push({
          checkId: "CKV_DOCKER_2",
          checkName: "Runs as root",
          severity: "low",
          file: file.path,
          message: "Dockerfile lacks USER instruction and may run as root.",
        });
      }
    }
  }

  const failed = checks.length;
  const skipped = 0;
  const passed = Math.max(0, files.length - failed);

  return {
    checks,
    passed,
    failed,
    skipped,
  };
}




