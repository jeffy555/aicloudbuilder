/**
 * OPA / Kyverno Policy Hints
 * AI-driven policy analysis using GPT-4o-mini for contextual Kubernetes policy recommendations.
 */
import { aiChatCompletion } from '../utils/ai-client.js';
import { z } from 'zod';
import { sanitizeContent } from '../utils/sanitize-prompt.js';

// ─── Zod schemas for AI response validation ─────────────────────────────────

const aiPolicyViolationSchema = z.object({
  resource: z.string(),
  kind: z.string(),
  reason: z.string(),
});
const aiPolicyHintSchema = z.object({
  id: z.string().optional().default(''),
  engine: z.enum(['kyverno', 'opa']).catch('kyverno'),
  severity: z.enum(['critical', 'high', 'medium', 'low']).catch('medium'),
  title: z.string().optional().default('Policy violation'),
  description: z.string().optional().default(''),
  remediation: z.string().optional().default(''),
  affectedKinds: z.array(z.string()).catch([]),
  docsUrl: z.string().optional(),
  violations: z.array(aiPolicyViolationSchema).catch([]),
});
const aiPolicyHintsResponseSchema = z.object({
  hints: z.array(aiPolicyHintSchema).catch([]),
});

export interface PolicyHint {
  id: string;
  engine: 'kyverno' | 'opa';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  remediation: string;
  affectedKinds: string[];
  docsUrl?: string;
}

export interface PolicyCheckResult {
  hint: PolicyHint;
  violations: Array<{ resource: string; kind: string; reason: string }>;
}

// ─── AI-Powered Policy Checker ───────────────────────────────────────────────

/**
 * Run AI-powered policy analysis against a list of YAML manifest strings.
 * Returns results only for policies that have at least one violation.
 */
export async function checkPolicyHints(manifests: string[]): Promise<PolicyCheckResult[]> {
  const manifestContent = manifests
    .join('\n---\n')
    .substring(0, 14000);

  if (!manifestContent.trim()) {
    return [];
  }

  try {
    console.log(`🤖 Running AI-powered policy hints analysis...`);

    const completion = await aiChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system' as const,
          content: `You are a Kubernetes policy expert specializing in Kyverno and OPA/Gatekeeper. Analyze these manifests and suggest applicable policies. For each policy, specify: id, engine (kyverno/opa), severity (critical/high/medium/low), title, description, remediation steps, and affected Kubernetes kinds.

For each policy you identify, also check the manifests for violations. A violation means a specific resource in the manifests does not comply with the policy.

Return ONLY this JSON (no markdown fencing):
{
  "hints": [
    {
      "id": "<unique-id like kyverno-require-labels or opa-privileged-containers>",
      "engine": "kyverno|opa",
      "severity": "critical|high|medium|low",
      "title": "<concise policy title>",
      "description": "<what the policy enforces and why>",
      "remediation": "<specific steps to fix violations>",
      "affectedKinds": ["Deployment", "StatefulSet", ...],
      "violations": [
        {
          "resource": "<Kind/name>",
          "kind": "<Kind>",
          "reason": "<why this resource violates the policy>"
        }
      ]
    }
  ]
}

Only include policies that have at least one violation in the provided manifests. Focus on real, actionable findings — not theoretical policies that don't apply.`,
        },
        {
          role: 'user' as const,
          content: `Analyze these Kubernetes manifests for policy violations:\n\n${sanitizeContent(manifestContent)}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '{}';
    let rawParsed: any = {};
    try { rawParsed = JSON.parse(raw); } catch { /* use defaults */ }

    const result = aiPolicyHintsResponseSchema.safeParse(rawParsed);
    if (!result.success) {
      console.warn('[policy-hints] AI response validation failed:', result.error.message);
      return [];
    }

    const results: PolicyCheckResult[] = [];

    for (const h of result.data.hints) {
      const violations = h.violations.filter(v => v.resource && v.kind && v.reason);

      if (violations.length === 0) continue;

      const hint: PolicyHint = {
        id: h.id || `policy-${results.length + 1}`,
        engine: h.engine,
        severity: h.severity,
        title: h.title,
        description: h.description,
        remediation: h.remediation,
        affectedKinds: h.affectedKinds,
        ...(h.docsUrl ? { docsUrl: h.docsUrl } : {}),
      };

      results.push({ hint, violations });
    }

    console.log(`✅ AI policy analysis complete: ${results.length} policies with violations found`);
    return results;
  } catch (aiError: any) {
    console.warn(`⚠️  AI policy hints analysis failed: ${aiError?.message ?? 'unknown error'} — returning empty results`);
    return [];
  }
}
