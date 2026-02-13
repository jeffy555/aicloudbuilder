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
  type: "terraform" | "kubernetes" | "dockerfile" | "automation",
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
      // Check for :latest tag usage
      if (/FROM\s+\S+:latest/i.test(file.content)) {
        checks.push({
          checkId: "CKV_DOCKER_1",
          checkName: "Using :latest tag",
          severity: "medium",
          file: file.path,
          message: "Dockerfile uses :latest tag which is not reproducible.",
          guideline: "Pin to a specific version tag for reproducible builds.",
        });
      }
      // Check for running as root
      if (!/USER\s+\S+/i.test(file.content) || /USER\s+root/i.test(file.content)) {
        checks.push({
          checkId: "CKV_DOCKER_2",
          checkName: "Container runs as root",
          severity: "high",
          file: file.path,
          message: "Dockerfile does not specify a non-root user.",
          guideline: "Add USER directive with a non-root user for security.",
        });
      }
      // Check for HEALTHCHECK
      if (!/HEALTHCHECK/i.test(file.content)) {
        checks.push({
          checkId: "CKV_DOCKER_3",
          checkName: "Missing HEALTHCHECK",
          severity: "low",
          file: file.path,
          message: "Dockerfile does not define a HEALTHCHECK instruction.",
          guideline: "Add HEALTHCHECK to enable container health monitoring.",
        });
      }
    } else if (type === "automation") {
      // Check for hardcoded credentials (all script types)
      if (/(?:password|api_key|secret|token|apikey|auth_token)\s*[=:]\s*["'][^"']{8,}["']/i.test(file.content)) {
        checks.push({
          checkId: "CKV_SCRIPT_1",
          checkName: "Hardcoded credentials",
          severity: "critical",
          file: file.path,
          message: "Script contains potential hardcoded credentials.",
          guideline: "Use environment variables or secret management for credentials.",
        });
      }

      // Shell-specific checks
      if (file.path.endsWith(".sh")) {
        // Check for dangerous commands
        if (/\beval\s+["'\$]|\bexec\s+\$/.test(file.content)) {
          checks.push({
            checkId: "CKV_SCRIPT_2",
            checkName: "Dangerous command usage",
            severity: "high",
            file: file.path,
            message: "Script uses eval or exec with variables which can be dangerous.",
            guideline: "Avoid eval/exec with untrusted input; validate inputs if required.",
          });
        }

        // Check for missing error handling
        if (!/set\s+-[euo]|set\s+-o\s+(errexit|pipefail|nounset)/.test(file.content)) {
          checks.push({
            checkId: "CKV_SCRIPT_3",
            checkName: "Missing error handling",
            severity: "medium",
            file: file.path,
            message: "Shell script does not enable error handling (set -e).",
            guideline: "Add 'set -e' or 'set -euo pipefail' to fail on errors.",
          });
        }

        // Check for curl/wget without SSL verification
        if (/curl\s+[^|;]*-k|curl\s+[^|;]*--insecure|wget\s+[^|;]*--no-check-certificate/.test(file.content)) {
          checks.push({
            checkId: "CKV_SCRIPT_4",
            checkName: "Insecure HTTP request",
            severity: "high",
            file: file.path,
            message: "Script disables SSL certificate verification.",
            guideline: "Remove -k/--insecure flags to enable SSL verification.",
          });
        }
      }

      // PowerShell-specific checks
      if (file.path.endsWith(".ps1")) {
        // Check for insecure TLS settings
        if (/\[System\.Net\.ServicePointManager\]::ServerCertificateValidationCallback/.test(file.content)) {
          checks.push({
            checkId: "CKV_SCRIPT_5",
            checkName: "SSL validation disabled",
            severity: "high",
            file: file.path,
            message: "PowerShell script disables SSL certificate validation.",
            guideline: "Remove custom certificate validation callbacks.",
          });
        }

        // Check for Invoke-Expression with variables
        if (/Invoke-Expression\s+\$/.test(file.content)) {
          checks.push({
            checkId: "CKV_SCRIPT_6",
            checkName: "Invoke-Expression with variable",
            severity: "high",
            file: file.path,
            message: "Using Invoke-Expression with variables can lead to code injection.",
            guideline: "Use direct command invocation instead of Invoke-Expression.",
          });
        }
      }

      // Python-specific checks
      if (file.path.endsWith(".py")) {
        // Check for subprocess with shell=True
        if (/subprocess\.\w+\([^)]*shell\s*=\s*True/.test(file.content)) {
          checks.push({
            checkId: "CKV_SCRIPT_7",
            checkName: "Subprocess shell injection risk",
            severity: "high",
            file: file.path,
            message: "Using subprocess with shell=True can lead to shell injection.",
            guideline: "Use subprocess with shell=False and pass arguments as list.",
          });
        }

        // Check for pickle usage (insecure deserialization)
        if (/import\s+pickle|from\s+pickle\s+import|\.load\(|\.loads\(/.test(file.content) && /pickle/.test(file.content)) {
          checks.push({
            checkId: "CKV_SCRIPT_8",
            checkName: "Insecure deserialization",
            severity: "high",
            file: file.path,
            message: "Using pickle for deserialization can lead to arbitrary code execution.",
            guideline: "Use safe serialization formats like JSON instead of pickle.",
          });
        }

        // Check for disabled SSL verification in requests
        if (/verify\s*=\s*False/.test(file.content)) {
          checks.push({
            checkId: "CKV_SCRIPT_9",
            checkName: "SSL verification disabled",
            severity: "high",
            file: file.path,
            message: "HTTP request disables SSL certificate verification.",
            guideline: "Remove verify=False to enable SSL verification.",
          });
        }
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




