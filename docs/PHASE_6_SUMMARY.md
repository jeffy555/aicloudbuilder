# Phase 6: Wire IntelligentFixRetriever into Request Path - COMPLETE ✅

**Implementation Date:** February 1, 2026
**Status:** ✅ All tasks completed — 26/26 validation tests passing (100%)
**Previous Phase:** Phase 5 - Gradual Template Deprecation
**Next Phase:** Phase 7 (TBD)

---

## Overview

Phase 6 connects the `IntelligentFixRetriever` singleton (built in Phase 4 but never called from any route) to the production fix pipeline in `routes-legacy.ts`. All three `remediationRAGService.findRemediation()` call sites are replaced by a single `getRemediation()` wrapper that delegates to the intelligent retriever when `ENABLE_INTELLIGENT_FIX_RETRIEVAL=true`, and falls through to the original RAG call when the flag is off. Verification feedback (`storeVerifiedFix` / `reportFixFailure`) is wired into the same success/failure block, also gated by the flag. Zero behaviour change when the flag is disabled.

---

## Completed Tasks

### ✅ Task 6.1: Import Wiring

**File:** `server/routes-legacy.ts` (lines 10–11)

```typescript
import { intelligentFixRetriever } from "./rag/intelligent-fix-retriever";
import { featureFlags } from "./middleware/feature-flags";
```

Both imports added alongside the existing `remediationRAGService` import. `featureFlags` was not previously imported in this file.

---

### ✅ Task 6.2: getRemediation Wrapper

**File:** `server/routes-legacy.ts` (lines 44–102)

A single wrapper replaces all three direct RAG calls. When the flag is on, it calls `intelligentFixRetriever.getFixForCheck()` and maps the `IntelligentFixResult` back to the RAG-compatible shape so all downstream prompt-building and verification logic works without modification.

```
Request arrives
        │
        ▼
┌───────────────────────────┐
│  featureFlags.             │
│  intelligentFixRetrieval?  │
└───┬───────────────┬───────┘
    │ yes           │ no
    ▼               ▼
intelligentFix   remediationRAGService
Retriever.       .findRemediation()
getFixForCheck() (unchanged)
    │
    ▼
Map IntelligentFixResult → RAG shape
(snippet, template, confidence, matchReason)
```

**Mapping details:**

| IntelligentFixResult field | Mapped to |
|---------------------------|-----------|
| `fix` | `snippet.fixSnippet` |
| `confidence` | `snippet.confidence` + top-level `confidence` |
| `source` | `snippet.source` (`checkov_official` → `'retrieved'`, `ai_generated` → `'generated'`, others → `'retrieved'`) |
| N/A | `snippet.id` — computed via SHA-256 of `checkId:resourceType` (same hash the store uses) |
| N/A | `matchReason` — set to `[intelligent] source=<source>` for log traceability |

The `userId` parameter is threaded from `session.userId` (the session's linked user, defined in `shared/schema.ts` line 17).

---

### ✅ Task 6.3: Call Site Replacement

**File:** `server/routes-legacy.ts`

Three call sites replaced:

| # | Context | Original | Replaced with |
|---|---------|----------|---------------|
| 1 | `detailedIssues` prompt builder | `remediationRAGService.findRemediation(...)` | `getRemediation(..., session.userId \|\| undefined)` |
| 2 | `remediationResults` coverage scan | Same | Same |
| 3 | `retryRemediationResults` retry path | Same | Same |

No downstream code was changed. The wrapper returns the same type (`ReturnType<typeof remediationRAGService.findRemediation>`) so `remediation.snippet`, `remediation.template`, `remediation.confidence`, and `remediation.matchReason` all remain valid.

---

### ✅ Task 6.4: Verification Callback Wiring

**File:** `server/routes-legacy.ts`

**Success path** — when Checkov confirms a fix passed:

```
isFixed === true
        │
        ▼
┌───────────────────────────┐
│  intelligentFixRetrieval? │
└───┬───────────────┬───────┘
    │ yes           │ no
    ▼               ▼
storeVerifiedFix   Legacy: updateFixFromVerification(id, true)
(global + user     + storeGeneratedFix() for low-confidence
 preference)         fixes
```

`storeVerifiedFix` internally:
1. Bumps confidence on the existing global snippet (or creates one at 0.95).
2. Stores/updates the user's personal preference row when `userFixPreferences` flag is also on.

**Failure path** — when Checkov confirms a fix still fails:

```
isFixed === false
        │
        ▼
┌───────────────────────────┐
│  intelligentFixRetrieval? │
└───┬───────────────┬───────┘
    │ yes           │ no
    ▼               ▼
reportFixFailure   Legacy: updateFixFromVerification(id, false)
(global −0.3,
 user pref −0.1)
```

Both paths thread `session.userId` so user-preference feedback flows through when the user is authenticated.

---

### ✅ Task 6.5: Validation Script

**File:** `server/scripts/validate-phase6.ts` (26 tests across 5 suites)

| Suite | Tests | What's Covered |
|-------|-------|----------------|
| 1. Import Wiring | 3 | `intelligentFixRetriever` and `featureFlags` imported; singleton exported |
| 2. getRemediation Wrapper | 6 | Function exists; flag check present; userId param; fallback to RAG; RAG-compatible shape mapping (fixSnippet, confidence) |
| 3. Call Site Replacement | 3 | Zero direct `findRemediation` calls outside wrapper; all 3 sites use `getRemediation`; all 3 thread `session.userId` |
| 4. Verification Callbacks | 8 | `storeVerifiedFix` and `reportFixFailure` called; both gated by flag; legacy paths preserved in else branches; both thread `session.userId` |
| 5. Feature Flag & Zero-Change | 6 | Flag env var wired; `.env` default is `false`; `IntelligentFixResult` exported; `getFixForCheck` / `storeVerifiedFix` / `reportFixFailure` method signatures present |

**Test Results:**
```
✅ Passed: 26/26 (100.0%)
❌ Failed: 0/26
```

**Run validation:**
```bash
npx tsx server/scripts/validate-phase6.ts
```

---

## Bugs Fixed During Phase 6

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Validation false positive: "outside wrapper" count | The JSDoc comment block above `getRemediation()` references `remediationRAGService.findRemediation()` in its description. The wrapper boundary was anchored at `async function getRemediation(` rather than the JSDoc start, so the comment text leaked into the "outside wrapper" substring. | Moved the boundary to the JSDoc opener `/** * Phase 6: Unified remediation retrieval wrapper.` |
| Validation misleading error on PASS (×2) | Suite 4 tests for flag gating used a ternary whose final else branch (`'too far from flag check'`) fired unconditionally, printing on PASS. Same recurring pattern fixed in Phases 3, 4, and 5. | Added explicit success → `undefined` branch to both ternaries. |

---

## Files Modified

```
server/
  routes-legacy.ts              Added imports, getRemediation wrapper, replaced 3 call sites,
                                gated verification callbacks

server/scripts/
  validate-phase6.ts            Offline validation suite (26 tests)

docs/
  PHASE_6_SUMMARY.md            This file
```

**Total Lines Added:** ~120 lines (production + validation)

---

## Architecture (Full Request-Path View)

```
POST /api/sessions/:id/fix-issues
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  getRemediation() — unified wrapper                     │
│                                                         │
│  flag ON  → intelligentFixRetriever.getFixForCheck()    │
│              ├─ Tier 1: user preferences                │
│              ├─ Tier 2: Checkov native (GitHub)         │
│              └─ Tier 3-5: RAG waterfall                 │
│                                                         │
│  flag OFF → remediationRAGService.findRemediation()     │
│              (original 5-tier waterfall, unchanged)     │
└────────────────────────┬────────────────────────────────┘
                         │ result (mapped to RAG shape)
                         ▼
              Build AI prompt with remediation context
                         │
                         ▼
              AI generates fixed Terraform
                         │
                         ▼
              Checkov re-scans fixed content
                         │
        ┌────────────────┴────────────────┐
        │ PASS                            │ FAIL
        ▼                                 ▼
flag ON → storeVerifiedFix()     flag ON → reportFixFailure()
flag OFF → legacy path           flag OFF → legacy path
```

---

## Feature Flag Reference

| Flag | Env Var | Default | Effect |
|------|---------|---------|--------|
| `intelligentFixRetrieval` | `ENABLE_INTELLIGENT_FIX_RETRIEVAL` | `false` | Routes all fix retrieval + verification feedback through IntelligentFixRetriever |

Setting the flag to `true` enables the full intelligent path. Setting it to `false` (or omitting it) leaves every code path identical to pre-Phase 6 behaviour.

---

## Success Criteria

### ✅ All Criteria Met

- [x] **intelligentFixRetriever imported** into `routes-legacy.ts`
- [x] **featureFlags imported** into `routes-legacy.ts`
- [x] **getRemediation wrapper** defined with flag gate, userId parameter, and RAG-compatible mapping
- [x] **All 3 call sites** replaced — zero direct `findRemediation` calls remain outside the wrapper
- [x] **session.userId threaded** through all 3 call sites and both verification callbacks
- [x] **storeVerifiedFix wired** on success, gated by flag, with legacy else branch preserved
- [x] **reportFixFailure wired** on failure, gated by flag, with legacy else branch preserved
- [x] **Zero behaviour change when flag is off** — fallback path is the original `findRemediation` call
- [x] **26/26 validation tests passing** (100% success rate)

---

## Verification

```bash
# Run Phase 6 validation (offline, no server required)
npx tsx server/scripts/validate-phase6.ts

# Enable intelligent fix retrieval at runtime
ENABLE_INTELLIGENT_FIX_RETRIEVAL=true npx tsx server/index.ts

# Enable full stack (all phases active)
ENABLE_INTELLIGENT_FIX_RETRIEVAL=true \
ENABLE_CHECKOV_NATIVE_FETCH=true \
ENABLE_USER_FIX_PREFERENCES=true \
npx tsx server/index.ts
```

---

*Document Version: 1.0*
*Last Updated: February 1, 2026*
