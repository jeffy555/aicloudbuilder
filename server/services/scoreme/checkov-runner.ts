import { aiChatCompletion } from '../../utils/ai-client.js';
import { z } from 'zod';
import { sanitizeField, sanitizeContent } from '../../utils/sanitize-prompt.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Checkov');

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiFindingSchema = z.object({
  checkId: z.string(),
  checkName: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  file: z.string(),
  message: z.string(),
  guideline: z.string().optional(),
  status: z.enum(['passed', 'failed']),
});
const aiCheckovResponseSchema = z.object({
  findings: z.array(aiFindingSchema).catch([]),
});

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

interface AIFinding {
  checkId: string;
  checkName: string;
  severity: CheckovSeverity;
  file: string;
  message: string;
  guideline?: string;
  status: "passed" | "failed";
}

const BATCH_SIZE = 10;

function getTypeSpecificPrompt(type: string): string {
  switch (type) {
    case "terraform":
      return `Focus on these Terraform security concerns:
- Public access enabled on storage, databases, or network resources
- Missing encryption (at rest and in transit) for storage accounts, databases, disks
- Overly permissive IAM roles or policies (wildcards in actions/resources)
- Missing tags for cost tracking and ownership
- Hardcoded secrets, passwords, or API keys in resource definitions
- Insecure protocols (HTTP instead of HTTPS, unencrypted connections)
- Missing logging and monitoring configuration (diagnostic settings, audit logs)
- Network exposure (open security group rules, 0.0.0.0/0 CIDR blocks)
- Unencrypted storage (blob storage, S3 buckets, disks without encryption)
- Missing backup configurations and disaster recovery settings
Use check IDs in the format CKV_TERRAFORM_xxx (e.g., CKV_TERRAFORM_001).`;

    case "kubernetes":
      return `Focus on these Kubernetes security concerns:
- Privileged containers (privileged: true)
- Containers running as root user (runAsNonRoot not set or runAsUser: 0)
- Missing resource limits and requests (CPU/memory)
- hostNetwork, hostPID, or hostIPC enabled
- Missing readiness/liveness probes
- Using :latest image tags instead of pinned versions
- Missing securityContext (allowPrivilegeEscalation, readOnlyRootFilesystem)
- Missing NetworkPolicies for namespace isolation
- Insecure capabilities (NET_RAW, SYS_ADMIN, ALL)
- Missing PodDisruptionBudgets for availability
Use check IDs in the format CKV_K8S_xxx (e.g., CKV_K8S_001).`;

    case "dockerfile":
      return `Focus on these Dockerfile security concerns:
- Using :latest tags instead of pinned version tags
- Running as root user (missing USER directive or USER root)
- Missing HEALTHCHECK instruction
- Using ADD instead of COPY (ADD can fetch remote URLs and auto-extract archives)
- Exposed secrets or credentials in ENV, ARG, or RUN commands
- Missing .dockerignore guidance (sensitive files could be included in build context)
- Insecure package installs (apt-get without --no-install-recommends, pip without --no-cache-dir)
- Missing version pinning for installed packages
Use check IDs in the format CKV_DOCKER_xxx (e.g., CKV_DOCKER_001).`;

    case "automation":
      return `Focus on these automation/script security concerns:
- Hardcoded credentials, API keys, tokens, or passwords
- Missing error handling (set -e in bash, try/catch in PowerShell/Python)
- Insecure downloads (curl -k, wget --no-check-certificate, disabled SSL)
- Use of eval/exec with variables (shell injection risk)
- Shell injection via unquoted variables or unsanitized input
- Insecure deserialization (pickle in Python, Invoke-Expression in PowerShell)
- Disabled SSL certificate verification (verify=False, --insecure)
Use check IDs in the format CKV_SCRIPT_xxx (e.g., CKV_SCRIPT_001).`;

    default:
      return `Analyze for general security vulnerabilities and misconfigurations.
Use check IDs in the format CKV_GENERAL_xxx.`;
  }
}

async function analyzeSecurityWithAI(
  type: "terraform" | "kubernetes" | "dockerfile" | "automation",
  fileBatch: Array<{ path: string; content: string }>
): Promise<AIFinding[]> {
  const filesContent = fileBatch
    .map((f) => `--- FILE: ${sanitizeField(f.path)} ---\n${sanitizeContent(f.content)}\n--- END FILE ---`)
    .join("\n\n");

  const typeSpecific = getTypeSpecificPrompt(type);

  const systemPrompt = `You are a security scanner similar to Checkov/tfsec/kubesec. Analyze these ${type} files for security vulnerabilities, misconfigurations, and best practice violations. For EACH issue found, provide: checkId (format CKV_{TYPE}_xxx), checkName, severity (critical/high/medium/low/info), file path, message describing the issue, and guideline for remediation. Also identify checks that PASSED (no issues found). Be thorough - check for ALL common security issues for this file type.

${typeSpecific}

Return a JSON object with this exact structure:
{
  "findings": [
    {
      "checkId": "CKV_..._001",
      "checkName": "Short name of check",
      "severity": "critical|high|medium|low|info",
      "file": "exact file path from input",
      "message": "Description of the issue or what was validated",
      "guideline": "Remediation guidance",
      "status": "passed|failed"
    }
  ]
}

Important:
- Include BOTH passed and failed findings
- For passed findings, the message should describe what was correctly configured
- Use the exact file paths as provided in the input
- Be specific about line-level issues when possible in the message
- Every file should have at least one finding (passed or failed)`;

  const response = await aiChatCompletion({
    model: "gpt-4o-mini",
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: `Analyze these files:\n\n${filesContent}` },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return [];
  }

  const result = aiCheckovResponseSchema.safeParse(JSON.parse(content));
  if (!result.success) {
    log.warn('AI response validation failed', { error: result.error.message });
    return [];
  }

  return result.data.findings;
}

export async function runCheckovOnFiles(
  type: "terraform" | "kubernetes" | "dockerfile" | "automation",
  files: Array<{ path: string; content: string }>
): Promise<CheckovRunResult> {
  if (files.length === 0) {
    return { checks: [], passed: 0, failed: 0, skipped: 0 };
  }

  // Batch files into groups of BATCH_SIZE
  const batches: Array<Array<{ path: string; content: string }>> = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    batches.push(files.slice(i, i + BATCH_SIZE));
  }

  // Process all batches in parallel
  const results = await Promise.allSettled(
    batches.map((batch) => analyzeSecurityWithAI(type, batch))
  );

  const allFindings: AIFinding[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allFindings.push(...result.value);
    } else {
      log.warn('AI batch analysis failed', { reason: String(result.reason) });
    }
  }

  // If all batches failed, return empty result
  if (allFindings.length === 0 && results.every((r) => r.status === "rejected")) {
    log.warn('All AI analysis batches failed, returning empty result');
    return { checks: [], passed: 0, failed: 0, skipped: 0 };
  }

  // Separate passed and failed findings
  const failedFindings = allFindings.filter((f) => f.status === "failed");
  const passedCount = allFindings.filter((f) => f.status === "passed").length;

  const checks: CheckovCheck[] = failedFindings.map((f) => ({
    checkId: f.checkId,
    checkName: f.checkName,
    severity: f.severity,
    file: f.file,
    message: f.message,
    guideline: f.guideline,
  }));

  return {
    checks,
    passed: passedCount,
    failed: failedFindings.length,
    skipped: 0,
  };
}
