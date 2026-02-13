# Kubernetes RAG Extension Plan

## Overview

Extend the existing Terraform RAG remediation system to support Kubernetes security fix retrieval and learning. This leverages the existing infrastructure rather than building from scratch.

---

## Current Architecture (Terraform)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Existing RAG Infrastructure                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────┐    ┌─────────────────────┐                │
│  │ intelligent-fix-    │    │ remediation-rag.ts  │                │
│  │ retriever.ts        │───▶│ (5-tier waterfall)  │                │
│  │ (Entry Point)       │    └─────────┬───────────┘                │
│  └─────────────────────┘              │                            │
│                                       ▼                            │
│  ┌─────────────────────┐    ┌─────────────────────┐                │
│  │ checkov-fetcher.ts  │    │ fix-snippet-store   │                │
│  │ (GitHub Parser)     │    │ (Persistence)       │                │
│  │ Path: terraform/    │    └─────────────────────┘                │
│  └─────────────────────┘                                           │
│                                                                     │
│  ┌─────────────────────┐    ┌─────────────────────┐                │
│  │ vector-store.ts     │    │ embedding-cache.ts  │                │
│  │ (Semantic Search)   │    │ (OpenAI Cache)      │                │
│  └─────────────────────┘    └─────────────────────┘                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Extension Strategy

### What Can Be Reused (No Changes)

| Component | File | Reason |
|-----------|------|--------|
| Vector Store | `vector-store.ts` | Generic embedding storage |
| Embedding Cache | `embedding-cache.ts` | Works with any text |
| Checkov Cache | `checkov-cache.ts` | Generic cache structure |
| User Preferences | `user-fix-preferences-store.ts` | Already supports any checkId |
| Confidence Scorer | `confidence-scorer.ts` | Algorithm is generic |

### What Needs Extension

| Component | File | Changes |
|-----------|------|---------|
| Fix Snippet Store | `fix-snippet-store.ts` | Add `framework` field (terraform/kubernetes) |
| Checkov Fetcher | `checkov-fetcher.ts` | Add K8s path + YAML inference logic |
| Remediation RAG | `remediation-rag.ts` | Framework-aware retrieval |
| Intelligent Retriever | `intelligent-fix-retriever.ts` | K8s-aware AI prompts |
| K8s Routes | `routes/kubernetes.ts` | Add fix retrieval endpoint |

---

## Implementation Phases

### Phase 1: Schema Extension

**File: `server/rag/fix-snippet-store.ts`**

Add `framework` field to distinguish Terraform vs Kubernetes snippets:

```typescript
export interface FixSnippet {
  id: string;
  checkId: string;               // CKV_K8S_1, CKV_AZURE_59
  resourceType: string;          // Deployment, azurerm_storage_account
  cloudProvider: string;         // azure | aws | gcp | kubernetes
  framework: 'terraform' | 'kubernetes';  // NEW: IaC framework
  fixSnippet: string;            // YAML or HCL snippet
  context: string;               // Full resource example
  guideline: string;
  source: 'retrieved' | 'generated' | 'human';
  confidence: number;
  successCount: number;
  failureCount: number;
  verified: boolean;
  deprecated: boolean;
  lastUsed: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

**Backward Compatibility:** Default `framework` to `'terraform'` for existing snippets.

---

### Phase 2: Checkov Fetcher Extension

**File: `server/rag/checkov-fetcher.ts`**

Add Kubernetes checks path and YAML inference:

```typescript
// Existing
const CHECKOV_TERRAFORM_PATH = 'checkov/terraform/checks';

// NEW
const CHECKOV_KUBERNETES_PATH = 'checkov/kubernetes/checks';

// Extend searchGitHub to accept framework parameter
private async searchGitHub(checkId: string, framework: 'terraform' | 'kubernetes'): Promise<string | null> {
  const checkPath = framework === 'kubernetes'
    ? CHECKOV_KUBERNETES_PATH
    : CHECKOV_TERRAFORM_PATH;

  const query = `${checkId}+repo:${CHECKOV_REPO}+path:${checkPath}`;
  // ... rest of search logic
}

// NEW: Infer YAML remediation from K8s check
inferKubernetesRemediation(parsed: ParsedCheck, resourceKind: string): InferredRemediation | null {
  // K8s checks typically look for:
  // - spec.containers[].securityContext.runAsNonRoot
  // - spec.containers[].resources.limits
  // - spec.containers[].livenessProbe

  // Parse Python scan logic to infer YAML path and expected value
}
```

**K8s-Specific Patterns to Detect:**

| Check Pattern | YAML Fix |
|---------------|----------|
| `runAsNonRoot` not True | `securityContext.runAsNonRoot: true` |
| Missing `resources.limits` | Add `resources.limits.cpu/memory` |
| Missing `livenessProbe` | Add `livenessProbe` block |
| `allowPrivilegeEscalation` True | `securityContext.allowPrivilegeEscalation: false` |
| Missing `readOnlyRootFilesystem` | `securityContext.readOnlyRootFilesystem: true` |

---

### Phase 3: Remediation RAG Extension

**File: `server/rag/remediation-rag.ts`**

Add framework-aware retrieval:

```typescript
async findRemediation(
  checkId: string,
  checkName: string,
  guideline: string,
  resourceType: string,
  framework: 'terraform' | 'kubernetes' = 'terraform'  // NEW parameter
): Promise<RemediationResult | null> {

  // Tier 1: Exact match in fix snippet store (filter by framework)
  const exactMatch = await fixSnippetStore.getByKey(checkId, resourceType, framework);

  // Tier 2: Semantic search (filter results by framework)
  const results = await queryVectorStore({
    query: queryText,
    topK: 5,
    filter: { framework }  // Vector store metadata filter
  });

  // Tier 3-5: Same as before, but framework-aware
}
```

---

### Phase 4: AI Prompt Extension

**File: `server/rag/intelligent-fix-retriever.ts`**

Add K8s-specific AI generation prompts:

```typescript
private async generateKubernetesFix(
  checkId: string,
  checkName: string,
  resourceKind: string,
  currentYaml: string
): Promise<string> {
  const prompt = `You are a Kubernetes security expert. Fix the following security issue:

Check ID: ${checkId}
Check Name: ${checkName}
Resource Kind: ${resourceKind}

Current YAML:
\`\`\`yaml
${currentYaml}
\`\`\`

Generate ONLY the YAML snippet that fixes this issue. Include:
1. The specific path (e.g., spec.containers[0].securityContext)
2. The corrected value
3. Any required parent blocks

Output format:
\`\`\`yaml
# Fix for ${checkId}
<yaml snippet>
\`\`\``;

  // Call OpenAI and extract YAML
}
```

---

### Phase 5: Kubernetes Workflow Integration

**File: `server/routes/kubernetes.ts`**

Add fix retrieval endpoint:

```typescript
// NEW: Get fix for Kubernetes security issue
app.post("/api/sessions/:id/kubernetes-fix", async (req, res) => {
  const { checkId, checkName, resourceKind, guideline, currentYaml } = req.body;
  const sessionId = req.params.id;

  // Get user ID for personalized fixes
  const session = await storage.getSession(sessionId);
  const userId = session?.userId;

  // Retrieve fix using intelligent retriever
  const fix = await intelligentFixRetriever.getFixForCheck(
    checkId,
    resourceKind,
    checkName,
    guideline,
    userId,
    currentYaml,
    'kubernetes'  // framework
  );

  if (fix) {
    res.json({
      success: true,
      fix: fix.fix,
      confidence: fix.confidence,
      source: fix.source,
      requiresReview: fix.requiresReview
    });
  } else {
    // Fallback to AI generation
    const generatedFix = await generateKubernetesFix(checkId, checkName, resourceKind, currentYaml);

    // Store for future use
    await intelligentFixRetriever.storeVerifiedFix(checkId, resourceKind, generatedFix, userId, false, 'kubernetes');

    res.json({
      success: true,
      fix: generatedFix,
      confidence: 0.6,
      source: 'ai_generated',
      requiresReview: true
    });
  }
});

// NEW: Verify fix worked
app.post("/api/sessions/:id/kubernetes-fix/verify", async (req, res) => {
  const { checkId, resourceKind, fix, success } = req.body;
  const session = await storage.getSession(req.params.id);

  if (success) {
    await intelligentFixRetriever.storeVerifiedFix(checkId, resourceKind, fix, session?.userId, true, 'kubernetes');
  } else {
    await intelligentFixRetriever.reportFixFailure(checkId, resourceKind, session?.userId);
  }

  res.json({ success: true });
});
```

---

### Phase 6: Initial K8s Fix Templates (Optional Bootstrap)

**Directory: `remediations/kubernetes/`**

Pre-seed common fixes to bootstrap the system:

```
remediations/kubernetes/
├── CKV_K8S_1_readiness_probe.yaml
├── CKV_K8S_2_liveness_probe.yaml
├── CKV_K8S_3_resource_limits.yaml
├── CKV_K8S_4_resource_requests.yaml
├── CKV_K8S_5_run_as_non_root.yaml
├── CKV_K8S_6_privilege_escalation.yaml
├── CKV_K8S_7_read_only_filesystem.yaml
├── CKV_K8S_8_drop_capabilities.yaml
└── CKV_K8S_9_image_tag.yaml
```

Example `CKV_K8S_5_run_as_non_root.yaml`:

```yaml
check_id: CKV_K8S_20
check_name: "Containers should not run with allowPrivilegeEscalation"
resource_kinds:
  - Deployment
  - Pod
  - StatefulSet
  - DaemonSet
  - Job
  - CronJob
yaml_path: "spec.containers[*].securityContext"
fix_snippet: |
  securityContext:
    runAsNonRoot: true
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
context: |
  spec:
    containers:
      - name: app
        image: nginx:1.21
        securityContext:
          runAsNonRoot: true
          allowPrivilegeEscalation: false
tags:
  - security
  - container
  - privilege
```

---

## Data Flow (After Extension)

```
┌─────────────────────────────────────────────────────────────────────┐
│                 Kubernetes Security Fix Flow                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Checkov detects CKV_K8S_20 (allowPrivilegeEscalation)          │
│                         │                                           │
│                         ▼                                           │
│  2. POST /api/sessions/:id/kubernetes-fix                          │
│     { checkId: "CKV_K8S_20", resourceKind: "Deployment", ... }     │
│                         │                                           │
│                         ▼                                           │
│  3. Intelligent Fix Retriever                                       │
│     ├─ Tier 1: User preference cache    → HIT? Return             │
│     ├─ Tier 2: Checkov GitHub fetch     → HIT? Store + Return     │
│     ├─ Tier 3: Global snippet cache     → HIT? Return             │
│     ├─ Tier 4: Semantic vector search   → HIT? Return             │
│     └─ Tier 5: AI generation            → Generate + Store        │
│                         │                                           │
│                         ▼                                           │
│  4. Return fix + confidence + source                               │
│     {                                                               │
│       fix: "securityContext:\n  allowPrivilegeEscalation: false",  │
│       confidence: 0.85,                                            │
│       source: "global_cache"                                       │
│     }                                                               │
│                         │                                           │
│                         ▼                                           │
│  5. User applies fix → Re-runs Checkov                             │
│                         │                                           │
│                         ▼                                           │
│  6. POST /api/sessions/:id/kubernetes-fix/verify                   │
│     { checkId: "CKV_K8S_20", success: true }                       │
│                         │                                           │
│                         ▼                                           │
│  7. Confidence updated: 0.85 → 0.95                                │
│     (Future retrievals auto-apply without review)                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Files to Modify

| Phase | File | Changes |
|-------|------|---------|
| 1 | `server/rag/fix-snippet-store.ts` | Add `framework` field |
| 2 | `server/rag/checkov-fetcher.ts` | Add K8s path + YAML inference |
| 3 | `server/rag/remediation-rag.ts` | Framework-aware retrieval |
| 4 | `server/rag/intelligent-fix-retriever.ts` | K8s AI prompts |
| 5 | `server/routes/kubernetes.ts` | Add fix endpoints |
| 6 | `remediations/kubernetes/*.yaml` | Bootstrap templates (optional) |

---

## Testing Plan

1. **Unit Tests**
   - K8s Checkov fetcher parses Python correctly
   - YAML fix inference works for common patterns
   - Framework filter in vector search works

2. **Integration Tests**
   - End-to-end: Checkov issue → Fix retrieval → Apply → Verify
   - Confidence increases after successful verification
   - Confidence decreases after failure, deprecates below 0.5

3. **Manual Testing**
   - Generate K8s manifests with security issues
   - Run Checkov scan
   - Request fixes for each issue
   - Verify fixes resolve issues

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Fix retrieval hit rate (Tier 1-4) | > 70% after 1 month |
| Fix success rate | > 85% |
| Average confidence for verified fixes | > 0.9 |
| AI generation fallback rate | < 30% |

---

## Rollout Plan

1. **Week 1:** Phases 1-2 (Schema + Fetcher)
2. **Week 2:** Phases 3-4 (RAG + AI Prompts)
3. **Week 3:** Phase 5 (Integration + Testing)
4. **Week 4:** Phase 6 (Bootstrap templates) + Production rollout

---

## Feature Flags

```typescript
// server/middleware/feature-flags.ts
export const featureFlags = {
  // Existing
  checkovNativeFetch: true,
  userFixPreferences: true,

  // NEW
  kubernetesRAG: process.env.ENABLE_KUBERNETES_RAG === 'true',
  kubernetesAIGeneration: process.env.ENABLE_K8S_AI_GEN === 'true',
};
```

Enable gradually:
1. First enable `kubernetesRAG` (retrieval only)
2. Then enable `kubernetesAIGeneration` (AI fallback)

---

## Summary

This plan extends the existing RAG infrastructure to support Kubernetes with minimal new code:

- **Reuses:** Vector store, embedding cache, confidence scoring, user preferences
- **Extends:** Fix snippet store, Checkov fetcher, retrieval logic
- **Adds:** K8s-specific AI prompts, new API endpoints, bootstrap templates

The system will learn from each fix, improving accuracy over time just like the Terraform RAG system.
