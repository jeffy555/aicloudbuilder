# UI Flow: From Security Scan to Verified Fix

This document traces the full user experience through the intelligent fix system — what the user sees at each stage, what happens behind the scenes, and how the Phases 3–7 backend work surfaces (or stays invisible) in the UI.

---

## High-Level Flow

```
┌─────────┐    ┌─────────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐
│  Select │───►│  Scan   │───►│  Review  │───►│   Fix   │───►│ Approve  │
│   Repo  │    │ Results │    │  & Pick  │    │Applied  │    │   &      │
│         │    │         │    │  Checks  │    │         │    │  Commit  │
└─────────┘    └─────────┘    └──────────┘    └─────────┘    └──────────┘
   Stage 1        Stage 2        Stage 3        Stage 4         Stage 5
```

---

## Stage 1 — Select Repository

**Page:** `TerraformWorkflow.tsx` (route: `/terraform`)

**What the user sees:**
- Step indicator showing workflow progress (Steps 1–7)
- Repository list fetched from GitHub or Azure DevOps
- Cloud provider selection card (Azure / AWS / GCP)

**What happens:**
- `useSecretsConfig` hook fetches the user's linked cloud credentials
- Session is created via `PATCH /api/sessions/:id` with the chosen provider
- `session.cloudProvider` is set — this value is threaded through the entire fix pipeline later (Phase 7)

```
User picks "Azure" + selects repo
        │
        ▼
session.cloudProvider = 'azure'   ← stored server-side
```

---

## Stage 2 — Security Scan

**Component:** `CheckovScanner.tsx`

**What the user sees:**
- "Scan" button (Shield icon)
- Progress indicator while scanning
- Summary card after scan: passed / failed / skipped counts + pass percentage bar
- Two tabs: **Failed** (default) and **Fixed**

**What happens (backend):**
```
POST /api/sessions/:id/scan
        │
        ▼
Checkov runs against all .tf files in the session
        │
        ▼
Returns: { summary, failedChecks[], passedChecks[] }
```

Each `failedCheck` contains: `checkId`, `checkName`, `resource`, `file`, `guideline`.

**UI rendering of each failed check:**
```
┌──────────────────────────────────────────────────┐
│  ☐  CKV_AZURE_59                                 │  ← checkbox for selection
│     Storage account public access not disabled   │
│     Resource: azurerm_storage_account.example    │
│     File: main.tf                                │
│     Guideline: https://checkov.io/...            │
└──────────────────────────────────────────────────┘
```

---

## Stage 3 — Review & Pick Checks

**Component:** `CheckovScanner.tsx` (Failed tab)

**What the user sees:**
- Checkbox next to each failed check
- "Select All" / "Deselect All" toggle
- "Fix Selected Issues" button (disabled until at least one check is selected)
- Badge showing count of selected checks

**What happens:** Pure client state — `selectedChecks` Set is updated. No API call yet.

```
User ticks 3 checks → selectedChecks = { 'CKV_AZURE_59', 'CKV_AZURE_3', 'CKV_AZURE_14' }
        │
        ▼
"Fix Selected Issues" button becomes active
```

---

## Stage 4 — Fix Applied

**Component:** `CheckovScanner.tsx` → calls backend → shows `FileDiffView`

**What the user sees (while fixing):**
- Button changes to spinner + "Fixing…" text
- Toast: "Fixing X selected issue(s)…"

**What the user sees (after fix):**
- Diff view panel appears showing **before / after** for each modified file
- Each diff is colour-coded: green for added lines, red for removed lines
- "Approve Changes" and "Revert Changes" buttons
- A badge showing how many files were modified

**What happens (backend) — this is where Phases 3–7 execute:**

```
POST /api/sessions/:id/fix-issues
  body: { failedChecks: [...], framework: 'terraform' }
        │
        ▼
For each failed check:
        │
        ├─ Phase 6: getRemediation() wrapper called
        │       │
        │       ├─ Flag ON  → intelligentFixRetriever.getFixForCheck()
        │       │       │
        │       │       ├─ Tier 1: User preference lookup (if authenticated + flag)
        │       │       │       └─ Hit? Return instantly. User sees their previous fix.
        │       │       │
        │       │       ├─ Tier 2: Checkov native (GitHub inference + cache)
        │       │       │       └─ Hit? Auto-store in global cache. Return.
        │       │       │
        │       │       └─ Tier 3-5: RAG waterfall
        │       │               ├─ Tier 1: Exact match (fix snippet store)
        │       │               ├─ Tier 2: Semantic search (vector DB)
        │       │               ├─ Tier 3: Template fallback (deprecated when 50+ verified)
        │       │               ├─ Tier 4: Checkov fetch (GitHub, if flag on)
        │       │               └─ Tier 5: null → AI generation triggered
        │       │
        │       └─ Flag OFF → remediationRAGService.findRemediation() (original path)
        │
        ▼
Remediation context injected into AI prompt
        │
        ▼
OpenAI generates fixed Terraform code
        │
        ▼
Checkov re-scans the fixed code (verification)
        │
        ├─ PASS → Phase 6: storeVerifiedFix() called
        │           ├─ Global snippet confidence bumped (+0.2)
        │           ├─ User preference stored (if authenticated)
        │           └─ Phase 7: session.cloudProvider threaded to store
        │
        └─ FAIL → Phase 6: reportFixFailure() called
                    ├─ Global snippet confidence decremented (−0.3)
                    ├─ User preference confidence decremented (−0.1)
                    └─ Auto-deprecate if confidence < 0.5
        │
        ▼
Response: { fileDiffs: [{ fileName, originalContent, fixedContent }], fixResults: [...] }
```

**What the user actually sees of all this:** Nothing. The diff view shows the end result. The tier selection, confidence updates, and cloud-provider threading all happen silently. The only visible signal is *speed* — repeat fixes for the same check return instantly once a verified snippet exists (Tier 1 hit).

---

## Stage 5 — Approve & Commit

**Component:** `CheckovScanner.tsx` (diff panel)

**What the user sees:**
- "Approve Changes" button (green, with checkmark icon)
- "Revert Changes" button (outline)
- After approval: green "Approved" badge replaces the buttons
- Toast: "Fixes Approved — You can now commit the code. Please run a security scan before committing."

**What happens:**
```
User clicks "Approve Changes"
        │
        ▼
fixesApproved = true
        │
        ▼
React Query invalidates + refetches session files
(UI now shows the fixed file contents in the code editor)
        │
        ▼
onFixesApproved callback fires → parent workflow can trigger commit
```

**If the user clicks "Revert Changes":**
- Diffs are cleared, original files are restored via query refetch
- Toast: "Changes Reverted"

---

## Repeat Scan (Optional)

After approving fixes, the user can click "Scan" again. The `CheckovScanner` re-scans all files. Previously fixed checks now appear in the **Fixed** tab with a verified badge. Any remaining failures can be selected and fixed again.

---

## Self-Learning Over Time

The UI doesn't expose the learning loop directly, but it manifests as behaviour:

| Interaction | What happens invisibly | User-visible effect |
|-------------|----------------------|---------------------|
| Fix passes Checkov | Snippet stored, confidence +0.2 | Next time: same fix applied instantly |
| Fix fails Checkov | Confidence −0.3; auto-deprecate at < 0.5 | Next time: different fix attempted |
| Same user, same check | User preference hit (Tier 1) | Fix applied without AI call — faster |
| Different cloud provider | cloudProvider flows through to store | Snippet tagged correctly for multi-cloud |
| 50+ verified snippets | Template deprecation gate triggers | Legacy YAML templates stop loading (invisible) |

---

## Component & API Reference

| Stage | Component / Page | API Endpoint | Key State |
|-------|-----------------|--------------|-----------|
| 1 | `TerraformWorkflow.tsx` | `PATCH /api/sessions/:id` | `session.cloudProvider` |
| 2 | `CheckovScanner.tsx` | `POST /api/sessions/:id/scan` | `scanResult` |
| 3 | `CheckovScanner.tsx` | — (client only) | `selectedChecks` |
| 4 | `CheckovScanner.tsx` | `POST /api/sessions/:id/fix-issues` | `fileDiffs`, `hasUnapprovedFixes` |
| 5 | `CheckovScanner.tsx` | — (client only) | `fixesApproved` |

---

## Activation Checklist

To enable the full intelligent fix system, set these env vars before starting the server:

```bash
# Minimum — activates the intelligent retriever (all tiers)
ENABLE_INTELLIGENT_FIX_RETRIEVAL=true

# Also enable Checkov native fetching (Tier 2 — GitHub inference)
ENABLE_CHECKOV_NATIVE_FETCH=true

# Also enable per-user fix preferences (Tier 1 — fastest path)
# Requires: users table + user_fix_preferences table in the database
ENABLE_USER_FIX_PREFERENCES=true
```

All flags default to `false`. The system works at every partial activation level:

| Flags enabled | Active tiers | Behaviour |
|---------------|-------------|-----------|
| None | RAG only | Original 5-tier waterfall, no user awareness |
| `INTELLIGENT_FIX_RETRIEVAL` | All tiers via retriever | Wrapper active; Tier 2 skipped (no GitHub); Tier 1 skipped (no prefs) |
| `+ CHECKOV_NATIVE_FETCH` | + Tier 2 | GitHub inference + auto-store enabled |
| `+ USER_FIX_PREFERENCES` | + Tier 1 | Full stack: user prefs → Checkov → RAG waterfall |

---

*Document Version: 1.0*
*Last Updated: February 1, 2026*
