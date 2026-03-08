/**
 * Helm Chart Generator
 * AI-powered generation of complete Helm charts with optional post-generation lint.
 */
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import yaml from 'js-yaml';

export interface HelmGenerateOptions {
  framework?: string;            // 'node' | 'python' | 'java' | 'go' | 'generic' | ...
  includeHPA?: boolean;          // generate templates/hpa.yaml (default: true)
  includeIngress?: boolean;      // generate templates/ingress.yaml (default: true)
  generateEnvOverlays?: boolean; // generate values-dev.yaml + values-prod.yaml (default: true)
  replicas?: number;             // default replica count (default: 2)
  port?: number;                 // container port (default: 8080)
  appContext?: string;           // For existing repos: analysis summary injected into prompt
}

export interface RepoAnalysisResult {
  appType: string;
  language: string;
  framework: string;
  description: string;
  detectedServices: string[];
  suggestedPort: number;
  suggestedReplicas: number;
}

/**
 * Analyse uploaded application files and return a structured summary
 * suitable for Helm chart generation.
 */
export async function analyzeRepositoryForHelm(
  files: Array<{ name: string; content: string }>
): Promise<RepoAnalysisResult> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Build a compact snapshot of file names + first 400 chars of each
  const snapshot = files
    .slice(0, 20)
    .map(f => `### ${f.name}\n${f.content.substring(0, 400)}${f.content.length > 400 ? '\n...(truncated)' : ''}`)
    .join('\n\n');

  const systemPrompt = `You are an expert DevOps engineer. Analyse the provided application files and return a JSON object describing the application for Helm chart generation.

Return ONLY this JSON (no markdown):
{
  "appType": "<api|web|worker|microservice|batch|fullstack|generic>",
  "language": "<typescript|javascript|python|java|go|csharp|ruby|php|mixed|unknown>",
  "framework": "<node|python|java|go|dotnet|ruby|php|generic>",
  "description": "<2-3 sentence description of the application suitable for a Helm chart generator, including services, ports, and any scaling needs>",
  "detectedServices": ["<list of service names, e.g. api, worker, postgres>"],
  "suggestedPort": <main application HTTP port as integer — MUST NOT be 80 or 443 (those are reverse-proxy/load-balancer ports). Look for EXPOSE in Dockerfile, PORT env var, or application server listen port. Default 8080 if uncertain>,
  "suggestedReplicas": <recommended replica count as integer, 1-3>
}`;

  const userPrompt = `Application files:\n\n${snapshot}`;

  console.log(`\n🔍 Analysing repository (${files.length} file(s))...`);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 500,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices[0]?.message?.content?.trim() || '{}';
  let parsed: Partial<RepoAnalysisResult> = {};
  try { parsed = JSON.parse(raw); } catch { /* use defaults */ }

  return {
    appType: parsed.appType || 'generic',
    language: parsed.language || 'unknown',
    framework: parsed.framework || 'generic',
    description: parsed.description || 'Application based on uploaded files.',
    detectedServices: parsed.detectedServices || [],
    suggestedPort: parsed.suggestedPort || 8080,
    suggestedReplicas: parsed.suggestedReplicas || 2,
  };
}

export interface HelmGenerateResult {
  chartName: string;
  files: Array<{ path: string; content: string }>;
  lintResult?: {
    status: 'passed' | 'warning' | 'failed';
    errors: string[];
    warnings: string[];
  };
}

/**
 * Generate a complete Helm chart using AI, then lint it in a temp directory.
 */
export async function generateHelmChart(
  description: string,
  options: HelmGenerateOptions = {}
): Promise<HelmGenerateResult> {
  const {
    framework = 'generic',
    includeHPA = true,
    includeIngress = true,
    generateEnvOverlays = true,
    replicas = 2,
    port = 8080,
    appContext,
  } = options;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ── Required files list ──────────────────────────────────────────────────
  const requiredFiles = [
    'Chart.yaml',
    'values.yaml',
    'templates/_helpers.tpl',
    'templates/deployment.yaml',
    'templates/service.yaml',
    'templates/serviceaccount.yaml',
    'templates/NOTES.txt',
    '.helmignore',
  ];
  if (includeIngress) requiredFiles.push('templates/ingress.yaml');
  if (includeHPA) requiredFiles.push('templates/hpa.yaml');
  if (generateEnvOverlays) {
    requiredFiles.push('values-dev.yaml', 'values-prod.yaml');
  }

  const systemPrompt = `You are an expert Helm chart author. Generate a production-ready Helm chart as a JSON object.

RESPONSE FORMAT (strict JSON, no markdown fencing):
{
  "chartName": "<slug-name>",
  "files": {
    "Chart.yaml": "<content>",
    "values.yaml": "<content>",
    "templates/_helpers.tpl": "<content>",
    "templates/deployment.yaml": "<content>",
    "templates/service.yaml": "<content>",
    "templates/serviceaccount.yaml": "<content>",
    "templates/NOTES.txt": "<content>",
    ".helmignore": "<content>"
    ${includeIngress ? ',"templates/ingress.yaml": "<content>"' : ''}
    ${includeHPA ? ',"templates/hpa.yaml": "<content>"' : ''}
    ${generateEnvOverlays ? ',"values-dev.yaml": "<content>","values-prod.yaml": "<content>"' : ''}
  }
}

KUBERNETES NAMING RULE (critical — violations break helm lint):
- NEVER use | quote on metadata.name fields — it adds literal double-quotes to Kubernetes resource names
  CORRECT:  name: {{ include "chart.fullname" . }}
  WRONG:    name: {{ include "chart.fullname" . | quote }}   ← literal quotes in name = BROKEN
- | quote is only for string VALUES in env vars, annotations, and labels — never for resource names

CHART NAME RULE (critical — violations break ALL template definitions):
- chartName MUST be lowercase alphanumeric with hyphens ONLY — example: "node-api"
- NEVER wrap it in quotes inside Go template define names:
  CORRECT:  {{- define "node-api.fullname" -}}
  WRONG:    {{- define ""node-api".fullname" -}}   ← literal quotes = BROKEN
  WRONG:    {{- define "\"node-api\".fullname" -}}  ← escaped quotes = BROKEN
- Every {{- define }}, {{ include }}, and {{ template }} call MUST use the plain unquoted name

CRITICAL YAML SYNTAX RULES (violations cause helm lint to fail):
- Every YAML key MUST have a colon AND space immediately after: "key: value"
  CORRECT: replicaCount: 2
  WRONG:   replicaCount 2      ← missing colon
  WRONG:   replicaCount:2      ← missing space after colon
- Use 2-space indentation only — NEVER tabs
- Strings containing ":" or "#" or leading/trailing spaces MUST be quoted: description: "A web app: v2"
- Multi-line descriptions: use a quoted string on one line, NOT a block scalar (|) — the JSON encoding makes block scalars unreliable
- Do NOT use YAML anchors (&) or aliases (*) — they do not survive JSON round-trips
- Boolean values must be unquoted: true / false — NOT "true" / "false"
- appVersion MUST be quoted: appVersion: "1.0.0" — NEVER appVersion: 1.0.0

REQUIRED Chart.yaml format (copy exactly, replace placeholders):
apiVersion: v2
name: CHARTNAME
description: "DESCRIPTION"
type: application
version: 0.1.0
appVersion: "1.0.0"

HELM CHART RULES:
1. Chart.yaml MUST use apiVersion: v2 with name, description, type: application, version: 0.1.0, appVersion
2. values.yaml defines ALL configurable values with sensible defaults:
   - replicaCount: ${replicas}
   - image.repository, image.tag, image.pullPolicy: IfNotPresent
   - service.type: ClusterIP, service.port: ${port}
   - resources.limits and resources.requests (realistic for ${framework})
   - autoscaling.enabled, autoscaling.minReplicas, autoscaling.maxReplicas, autoscaling.targetCPUUtilizationPercentage
   - ingress.enabled, ingress.className, ingress.hosts, ingress.tls
   - serviceAccount.create: true, serviceAccount.name: ""
   - podAnnotations, podSecurityContext, securityContext
3. templates/_helpers.tpl MUST define:
   - <chartname>.name
   - <chartname>.fullname (uses Release.Name + chart name, max 63 chars)
   - <chartname>.chart
   - <chartname>.labels (standard Helm labels)
   - <chartname>.selectorLabels
   - <chartname>.serviceAccountName
4. templates/deployment.yaml MUST:
   - Use {{ include "<chartname>.fullname" . }} for names
   - Use {{ .Values.replicaCount }} for replicas
   - Use {{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }} for image
   - Set securityContext from values
   - Include livenessProbe and readinessProbe (httpGet on /health or /)
   - Use resources from values
5. templates/ingress.yaml: conditional on .Values.ingress.enabled, use networking.k8s.io/v1
   CRITICAL Go template scoping rule: inside ANY {{- range }} loop, NEVER use {{ include "..." . }} or {{ . }}
   to reference the chart root — use {{ $ }} and {{ include "..." $ }} instead. Example correct ingress pattern:
   {{- range .Values.ingress.hosts }}
   - host: {{ .host }}
     http:
       paths:
         {{- range .paths }}
         - path: {{ .path }}
           pathType: {{ .pathType }}
           backend:
             service:
               name: {{ include "CHARTNAME.fullname" $ }}
               port:
                 number: {{ $.Values.service.port }}
         {{- end }}
   {{- end }}
   This applies to ALL range loops in ALL templates — always use $ for root, . for the loop variable only.
6. templates/hpa.yaml: conditional on .Values.autoscaling.enabled, use autoscaling/v2
7. values-dev.yaml: low resource limits, 1 replica, ingress disabled
8. values-prod.yaml: high resources, ${Math.max(replicas, 3)} replicas, ingress enabled with TLS placeholder
9. .helmignore: exclude .git, *.md, .DS_Store, Makefile, tests/
10. NOTES.txt: show service URL instructions using kubectl get svc

NO Terraform, no raw K8s manifests without Helm templating. Everything parameterized via values.yaml.`;

  const userPrompt = `Generate a Helm chart for the following application:

${description}
${appContext ? `\nEXISTING APPLICATION CONTEXT (analysed from repo files — use this to inform ports, services, resource limits, and naming):\n${appContext}\n` : ''}
Framework: ${framework}
Default replicas: ${replicas}
Container port: ${port}
Include HPA: ${includeHPA}
Include Ingress: ${includeIngress}
Generate dev/prod value overlays: ${generateEnvOverlays}

Required files: ${requiredFiles.join(', ')}

Return JSON with chartName and all file contents. Ensure templates use proper Go template syntax with {{ }} and the _helpers.tpl includes.
CRITICAL: In every range loop, use $ for root context and include calls (e.g. {{ include "chart.fullname" $ }}), never {{ . }} for root inside a loop.`;

  console.log(`\n⛵ ========== HELM CHART GENERATION ==========`);
  console.log(`   Description: "${description.substring(0, 100)}..."`);
  console.log(`   Framework: ${framework}, HPA: ${includeHPA}, Ingress: ${includeIngress}, Overlays: ${generateEnvOverlays}`);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 8000,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices[0]?.message?.content?.trim() || '{}';
  let parsed: { chartName?: string; files?: Record<string, string> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI returned invalid JSON for Helm chart generation');
  }

  // Sanitize chart name: strip surrounding quotes the AI may have added, then enforce RFC 1123
  const rawChartName = (parsed.chartName || 'my-chart').trim().replace(/^["']+|["']+$/g, '');
  const chartName = (rawChartName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-')) || 'my-chart';

  const filesMap: Record<string, string> = parsed.files || {};

  // Post-process all file contents: replace any quoted/escaped variants of the chart name
  // that the AI may have written inside Go template {{- define "..." }} expressions.
  // Variants the AI generates: "node-api", '"node-api"', '\"node-api\"'
  const quotedVariants = [
    `"${rawChartName}"`,
    `'${rawChartName}'`,
    `\\"${rawChartName}\\"`,
    `"${chartName}"`,   // also cover the already-sanitized form wrapped in quotes
  ].filter(v => v.replace(/['"\\]/g, '').length > 0); // skip empty-string variants

  for (const [filePath, content] of Object.entries(filesMap)) {
    let fixed = String(content);
    for (const variant of quotedVariants) {
      fixed = fixed.split(variant).join(chartName);
    }
    // Remove | quote from name: lines in template files — it adds literal double-quotes
    // to Kubernetes resource names, causing helm lint to fail with "does not conform to naming requirements"
    if (filePath.startsWith('templates/') && (filePath.endsWith('.yaml') || filePath.endsWith('.yml'))) {
      fixed = fixed.replace(/^(\s*name:\s*\{\{[^}]+)\|\s*quote\s*(-?\}\})/gm, '$1$2');
    }
    filesMap[filePath] = fixed;
  }

  // Force the Chart.yaml name field to match the sanitized chartName
  if (filesMap['Chart.yaml']) {
    filesMap['Chart.yaml'] = filesMap['Chart.yaml'].replace(/^name:\s*.+$/m, `name: ${chartName}`);
  }

  if (!filesMap['Chart.yaml'] || !filesMap['values.yaml']) {
    throw new Error('AI response missing required Chart.yaml or values.yaml');
  }

  const files: Array<{ path: string; content: string }> = Object.entries(filesMap)
    .filter(([, content]) => typeof content === 'string' && content.trim().length > 0)
    .map(([filePath, content]) => ({ path: filePath, content }));

  console.log(`   ✅ AI generated ${files.length} file(s): ${files.map(f => f.path).join(', ')}`);

  // ── Pre-lint: validate YAML syntax on non-tpl files ─────────────────────
  const yamlErrors: string[] = [];
  for (const file of files) {
    if (file.path.endsWith('.tpl') || file.path === 'templates/NOTES.txt' || file.path === '.helmignore') continue;
    // Strip Go template expressions before YAML parsing to avoid false positives.
    // Strategy:
    //   1. Lines that are entirely a template directive (if/end/range/with/else) → remove the line
    //      so the real YAML content beneath isn't treated as a second document.
    //   2. Inline value expressions ({{ .Values.foo }}) → replace with 'x' (safe YAML scalar).
    const stripped = file.content
      .replace(/^\s*\{\{-?[^}]*-?\}\}\s*$/gm, '')  // whole-line directives → empty line
      .replace(/\{\{-?[^}]*-?\}\}/g, 'x')           // inline expressions → 'x'
      .replace(/^#.*$/gm, '');                        // strip comments
    try {
      yaml.load(stripped);
    } catch (yamlErr: any) {
      const msg = yamlErr.message?.replace(/\n[\s\S]*/,'') || 'invalid YAML';
      yamlErrors.push(`${file.path}: ${msg}`);
      console.warn(`   ⚠️  YAML syntax error in ${file.path}: ${msg}`);
    }
  }

  // ── Post-generation lint in temp directory ────────────────────────────────
  let lintResult: HelmGenerateResult['lintResult'];

  if (yamlErrors.length > 0) {
    // Skip helm lint — report YAML errors directly so the user sees the real issue
    lintResult = {
      status: 'failed',
      errors: yamlErrors,
      warnings: [],
    };
    console.warn(`   ❌ ${yamlErrors.length} YAML syntax error(s) — skipping helm lint`);
  } else {
    const tempDir = path.join(os.tmpdir(), `helm-gen-${randomUUID()}`);
    try {
      // Write files to temp dir preserving directory structure
      for (const file of files) {
        const fullPath = path.join(tempDir, file.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, 'utf-8');
      }

      // Import and run helm lint
      const { lintHelmChart } = await import('./helm-validator');
      const lint = await lintHelmChart(tempDir);

      lintResult = {
        status: lint.status,
        errors: lint.errors.map(e => e.message),
        warnings: lint.warnings.map(w => w.message),
      };
      console.log(`   Lint result: ${lint.status} (${lint.errors.length} errors, ${lint.warnings.length} warnings)`);
    } catch (lintError: any) {
      // Lint failure (e.g., helm not installed) is non-fatal
      console.warn(`   ⚠️  Helm lint skipped: ${lintError.message}`);
      lintResult = undefined;
    } finally {
      // Cleanup temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  console.log('=============================================\n');

  return { chartName, files, lintResult };
}
