# Kubernetes RAG Extension - Implementation Summary

## Overview

This document summarizes the implementation of the Kubernetes RAG (Retrieval-Augmented Generation) extension, which extends the existing Terraform security fix retrieval system to support Kubernetes manifest remediation.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         END-TO-END FLOW                                  │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌─────────────┐     POST /fix-issues      ┌─────────────────────────┐ │
│   │   UI        │     framework='kubernetes' │   routes-legacy.ts      │ │
│   │ CheckovScanner ─────────────────────────▶│   fix-issues endpoint  │ │
│   └─────────────┘                            └───────────┬─────────────┘ │
│         │                                                │               │
│         │ Security Scan                                  ▼               │
│         │                            ┌─────────────────────────────────┐ │
│         ▼                            │  Intelligent Fix Retriever      │ │
│   ┌─────────────┐                    │  (RAG 6-Tier Waterfall)        │ │
│   │ Checkov     │                    └───────────┬─────────────────────┘ │
│   │ Kubernetes  │                                │                       │
│   └─────────────┘                                ▼                       │
│                                      ┌─────────────────────────────────┐ │
│                                      │  Fix Snippet Store              │ │
│                                      │  (Self-Learning Cache)          │ │
│                                      └─────────────────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## UI Integration (Fully Wired)

### Flow: UI → Backend → RAG

```
┌──────────────────────────────────────────────────────────────────────┐
│                    KUBERNETES SECURITY FIX FLOW                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  1. KubernetesWorkflow.tsx                                           │
│     └─▶ ActivityPanel.tsx (workflowType='kubernetes')                │
│         └─▶ CheckovScanner.tsx (framework='kubernetes')              │
│                                                                       │
│  2. User clicks "Security Scan"                                      │
│     └─▶ POST /api/sessions/:id/scan-kubernetes                       │
│         └─▶ Checkov scans YAML files                                 │
│                                                                       │
│  3. User selects failed checks and clicks "Fix Selected"             │
│     └─▶ POST /api/sessions/:id/fix-issues                            │
│         Body: { failedChecks: [...], framework: 'kubernetes' }       │
│                                                                       │
│  4. Backend (routes-legacy.ts:7672-7900)                             │
│     └─▶ For each check:                                              │
│         └─▶ intelligentFixRetriever.getFixForCheck(                  │
│               checkId, resourceKind, checkName, guideline,           │
│               userId, context, 'kubernetes', 'kubernetes'            │
│             )                                                        │
│                                                                       │
│  5. RAG retrieves fix via 6-tier waterfall                           │
│     └─▶ Fix snippets included in AI prompt for YAML generation       │
│                                                                       │
│  6. After successful fix verification:                               │
│     └─▶ intelligentFixRetriever.storeVerifiedFix(...)                │
│         └─▶ Confidence increases (self-learning)                     │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Key UI Components

| Component | File | Role |
|-----------|------|------|
| KubernetesWorkflow | `client/src/pages/KubernetesWorkflow.tsx` | Main workflow page |
| ActivityPanel | `client/src/components/ActivityPanel.tsx` | Security/Diagram/Validate buttons |
| CheckovScanner | `client/src/components/CheckovScanner.tsx` | Scan + Fix UI |

### Backend Integration Point

**File:** `server/routes-legacy.ts` (lines 7672-7900)

```typescript
// For Kubernetes, use RAG-based fix retrieval with YAML-specific logic
if (framework === 'kubernetes') {
  // Phase 6: Get fixes from RAG system for each check
  for (const check of batchChecks) {
    const ragResult = await intelligentFixRetriever.getFixForCheck(
      check.checkId,
      resourceKind,
      check.checkName || check.checkId,
      check.guideline || '',
      session.userId || undefined,
      currentFileContent, // Pass current YAML as context
      'kubernetes',       // cloudProvider
      'kubernetes'        // framework
    );
    // ... use ragResult.fix in prompt
  }

  // After verification, store back to RAG for learning
  await intelligentFixRetriever.storeVerifiedFix(
    check.checkId,
    resourceKind,
    ragFix.fix,
    session.userId || undefined,
    true, // verified
    'kubernetes',
    'kubernetes'
  );
}
```

---

## Implementation Phases

### Phase 1: Schema Extension ✅

**File:** `server/rag/fix-snippet-store.ts`

Added framework differentiation to support both Terraform and Kubernetes:

```typescript
export type IaCFramework = 'terraform' | 'kubernetes';

export interface FixSnippet {
  // ... existing fields ...
  framework: IaCFramework;  // NEW: terraform | kubernetes
}
```

**Key Changes:**
- Added `IaCFramework` type: `'terraform' | 'kubernetes'`
- Added `framework` field to `FixSnippet` interface
- Updated `generateId()` to include framework in hash
- Updated `getByKey()` to accept framework parameter
- Added `getByFramework()` method for filtering

---

### Phase 2: Checkov Fetcher Extension ✅

**File:** `server/rag/checkov-fetcher.ts`

Extended to fetch and infer fixes from Kubernetes Checkov checks:

```typescript
const CHECKOV_KUBERNETES_PATH = 'checkov/kubernetes/checks';

async fetchRemediation(
  checkId: string,
  resourceType: string,
  framework: IaCFramework = 'terraform'
): Promise<InferredRemediation | null>
```

**14 Kubernetes Pattern Matchers:**
- `runAsNonRoot`, `allowPrivilegeEscalation`, `readOnlyRootFilesystem`
- `capabilities` (drop ALL), `resource limits/requests`
- `livenessProbe`, `readinessProbe`, `image tag` (not latest)
- `hostNetwork`, `hostPID`, `hostIPC`, `privileged`
- `automountServiceAccountToken`

---

### Phase 3: Remediation RAG Extension ✅

**File:** `server/rag/remediation-rag.ts`

Made the entire RAG pipeline framework-aware:

```typescript
async findRemediation(
  checkId: string,
  checkName: string,
  guideline: string,
  resourceType: string,
  framework: IaCFramework = 'terraform'
): Promise<RemediationResult | null>
```

---

### Phase 4: AI Prompt Extension ✅

**File:** `server/rag/intelligent-fix-retriever.ts`

Added AI generation fallback with framework-specific prompts:

- `getKubernetesSystemPrompt()` - K8s security expert prompt
- `getKubernetesUserPrompt()` - K8s fix generation prompt

**Feature Flags:**
```typescript
kubernetesRAG: process.env.ENABLE_KUBERNETES_RAG === 'true',
kubernetesAIGeneration: process.env.ENABLE_K8S_AI_GEN === 'true',
```

---

### Phase 5: Kubernetes Workflow Integration ✅

**File:** `server/routes/kubernetes.ts`

Added three standalone API endpoints (for direct API access):

| Endpoint | Purpose |
|----------|---------|
| `POST /api/sessions/:id/kubernetes-fix` | Single fix retrieval |
| `POST /api/sessions/:id/kubernetes-fixes/batch` | Batch fixes |
| `POST /api/sessions/:id/kubernetes-fix/verify` | Fix verification |

---

### Phase 6: UI Integration ✅

**File:** `server/routes-legacy.ts`

Integrated RAG into the existing `/fix-issues` endpoint:

- CheckovScanner passes `framework: 'kubernetes'`
- Backend calls `intelligentFixRetriever.getFixForCheck()` for each check
- RAG-provided fixes are included in the AI prompt as "RECOMMENDED FIX"
- Verified fixes are stored back via `storeVerifiedFix()`

---

## 6-Tier Fix Retrieval Waterfall

```
┌─────────────────────────────────────────────────────────────┐
│                     Fix Retrieval Flow                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   TIER 1: User Preferences (if authenticated)               │
│      ↓ miss                                                  │
│   TIER 2: Checkov Native Fetch (GitHub API)                 │
│      ↓ miss                                                  │
│   TIER 3: Global Cache (Exact Match)                        │
│      ↓ miss                                                  │
│   TIER 4: Semantic Search (Vector Similarity)               │
│      ↓ miss                                                  │
│   TIER 5: Template Match (YAML files) - DISABLED            │
│      ↓ miss                                                  │
│   TIER 6: AI Generation (GPT-4o-mini)                       │
│                                                              │
│   All successful retrievals → Store in Global Cache         │
│   All verified fixes → Confidence++ (self-learning)         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Note:** Bootstrap templates are disabled for Kubernetes (pure AI-driven approach). Fixes are generated dynamically and cached for future use.

---

## Self-Learning Mechanism

```
┌────────────────────────────────────────────────────────────────┐
│                    SELF-LEARNING FLOW                          │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  First Occurrence:                                             │
│    CKV_K8S_20 → No cache hit → AI generates fix               │
│    └─▶ Stored with confidence = 0.60                          │
│                                                                 │
│  User Verifies Fix Worked:                                     │
│    └─▶ storeVerifiedFix() called                              │
│    └─▶ Confidence increases to 0.95                           │
│                                                                 │
│  Second Occurrence:                                            │
│    CKV_K8S_20 → Cache HIT (Tier 3)                            │
│    └─▶ Instant retrieval                                       │
│    └─▶ requiresReview = false (high confidence)               │
│                                                                 │
│  If Fix Fails:                                                 │
│    └─▶ Confidence decreases                                    │
│    └─▶ Below 0.5 → marked deprecated                          │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variables

```env
# Enable Kubernetes RAG system
ENABLE_KUBERNETES_RAG=true

# Enable AI generation fallback for K8s
ENABLE_K8S_AI_GEN=true

# OpenAI API key (for Tier 6 AI generation)
OPENAI_API_KEY=sk-...

# GitHub token (optional, increases rate limits)
GITHUB_TOKEN=ghp_...
```

---

## Files Modified

| File | Changes |
|------|---------|
| `server/rag/fix-snippet-store.ts` | Added `IaCFramework` type, `framework` field |
| `server/rag/checkov-fetcher.ts` | Added K8s path, `inferKubernetesRemediation()` |
| `server/rag/remediation-rag.ts` | Framework-aware retrieval |
| `server/rag/intelligent-fix-retriever.ts` | Tier 6 AI generation, K8s prompts |
| `server/middleware/feature-flags.ts` | Added K8s feature flags |
| `server/routes/kubernetes.ts` | Added 3 standalone fix endpoints |
| `server/routes-legacy.ts` | RAG integration in fix-issues endpoint |

---

## Validation Results

### API Endpoint Tests ✅

```bash
# Single fix retrieval
POST /api/sessions/:id/kubernetes-fix
Response: { fix: "...", confidence: 0.75, source: "ai_generated" }

# Batch retrieval
POST /api/sessions/:id/kubernetes-fixes/batch
Response: { totalChecks: 2, fixesFound: 2, results: [...] }

# Fix verification
POST /api/sessions/:id/kubernetes-fix/verify
Response: { success: true, message: "Confidence increased" }
```

### Self-Learning Verified ✅

| Request | Confidence | Source |
|---------|------------|--------|
| First (CKV_K8S_1) | 0.60 | ai_generated |
| After verification | 0.80 | ai_generated |
| Subsequent | 0.80+ | cache (instant) |

---

## Usage in UI

1. Navigate to **Kubernetes** module
2. Generate or upload Kubernetes manifests
3. Click **Security Scan** button
4. View failed Checkov checks
5. Select checks and click **Fix Selected**
6. RAG retrieves/generates fixes automatically
7. Fixes applied and verified via re-scan
8. Confidence increases for future use

---

## Summary

| Feature | Status |
|---------|--------|
| Schema Extension (framework field) | ✅ Complete |
| Checkov Fetcher (K8s patterns) | ✅ Complete |
| Remediation RAG (framework-aware) | ✅ Complete |
| AI Generation (K8s prompts) | ✅ Complete |
| Standalone API Endpoints | ✅ Complete |
| UI Integration (fix-issues) | ✅ Complete |
| Self-Learning (verification) | ✅ Complete |
| Pure AI Approach (no templates) | ✅ Active |

**Implementation Status: COMPLETE**

The Kubernetes RAG extension is fully integrated and operational. The system learns from every fix verification, improving accuracy over time without requiring manual template maintenance.
