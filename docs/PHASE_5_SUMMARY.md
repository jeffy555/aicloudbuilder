# Phase 5: Gradual Template Deprecation - COMPLETE ✅

**Implementation Date:** February 1, 2026
**Status:** ✅ All tasks completed — 20/20 validation tests passing (100%)
**Previous Phase:** Phase 4 - Intelligent Fix Retriever
**Next Phase:** Phase 6 - Wire IntelligentFixRetriever into Request Path

---

## Overview

Phase 5 adds an automated deprecation gate to the RAG service's `initialize()` method. Once the global fix snippet store accumulates enough verified fixes (default: 50), legacy YAML templates stop loading entirely. Tier 3 in the retrieval waterfall becomes a natural no-op — no code change was needed there because it already searches `this.templates`, which stays as an empty array when the gate triggers. The threshold is tunable at runtime via the `TEMPLATE_DEPRECATION_THRESHOLD` env var. YAML files remain on disk as documentation only.

---

## Completed Tasks

### ✅ Task 5.1: getVerifiedCount() Method

**File:** `server/rag/fix-snippet-store.ts`

Added a synchronous method that counts snippets where `verified === true` and `deprecated === false`. Runs against the in-memory map — no I/O. Placed alongside the existing `getStats()` method.

```typescript
getVerifiedCount(): number {
  return Array.from(this.snippets.values())
    .filter(s => s.verified && !s.deprecated).length;
}
```

Also exported the `FixSnippetStore` class (it was previously only available as a singleton). This matches the pattern already used by `checkov-cache.ts` and allows the validation script to create isolated test instances.

---

### ✅ Task 5.2: Threshold Gate in initialize()

**File:** `server/rag/remediation-rag.ts`

Replaced the unconditional template load block with a two-branch gate:

```
snippets loaded from disk
        │
        ▼
┌───────────────────────────────┐
│  verifiedCount >= threshold?  │
└───┬───────────────────────┬───┘
    │ yes                   │ no
    ▼                       ▼
Templates skipped      loadTemplatesFromDirectory()
Log: "Templates       Log: "Loaded N template(s)
      deprecated"           (M verified < threshold T)"
```

- **Threshold source:** `process.env.TEMPLATE_DEPRECATION_THRESHOLD`, defaults to `'50'`.
- **Ordering:** The gate runs *after* `fixSnippetStore.loadFromDisk()` completes, so the verified count reflects the current on-disk state.
- **Template indexing** was already conditional on `this.templates.length > 0` — no change needed there.
- **Tier 3** (`this.templates.find(...)`) was already conditional on the array contents — no change needed. When templates are skipped, Tier 3 simply finds nothing and falls through to Tier 4.

---

### ✅ Task 5.3: Environment Variable

**File:** `.env` (line 69–70)

```
# Phase 5: Stop loading legacy YAML templates once verified fix count reaches this number
TEMPLATE_DEPRECATION_THRESHOLD=50
```

Set to `0` to force immediate deprecation (useful for testing). Remove or set to a very high number to keep templates active indefinitely.

---

### ✅ Task 5.4: Validation Script

**File:** `server/scripts/validate-phase5.ts` (20 tests across 4 suites)

| Suite | Tests | What's Covered |
|-------|-------|----------------|
| 1. File Structure & Env Var | 4 | Modified files exist; `.env` has the threshold var with default 50 |
| 2. getVerifiedCount Method | 6 | Source has method + correct filter; live tests against an isolated store: empty → 0, unverified → 0, verified → 1, deprecated verified → still 1 |
| 3. Threshold Gate in initialize() | 7 | Env var read with default; `getVerifiedCount()` called; gate condition present; deprecation + load log messages present; indexing still conditional; gate runs after `loadFromDisk()` |
| 4. Tier 3 Natural No-op | 3 | Tier 3 searches `this.templates`; array initialised as `[]`; no redundant gate added inside Tier 3 |

**Test Results:**
```
✅ Passed: 20/20 (100.0%)
❌ Failed: 0/20
```

**Run validation:**
```bash
npx tsx server/scripts/validate-phase5.ts
```

---

## Files Modified

```
server/rag/
  fix-snippet-store.ts          Added getVerifiedCount(); exported FixSnippetStore class
  remediation-rag.ts            Replaced unconditional template load with threshold gate

.env                            Added TEMPLATE_DEPRECATION_THRESHOLD=50

server/scripts/
  validate-phase5.ts            Offline validation suite (20 tests)

docs/
  PHASE_5_SUMMARY.md            This file
```

**Total Lines Added:** ~80 lines (production + validation)

---

## Deprecation Lifecycle

```
Day 0        Day N (verified hits 50)        Future
  │                    │                        │
  ▼                    ▼                        ▼
Templates          Gate triggers           YAML files remain
load normally      on next server          on disk as
(verified < 50)    restart                 documentation only
                   Templates stop          No code change
                   loading                 needed to remove
                   Tier 3 is a no-op       them later
```

The transition is automatic and irreversible at runtime — once verified count crosses the threshold, templates never reload until the count drops back below (which cannot happen because `verified` is only set to `true`, never back to `false`). To force templates back on, raise `TEMPLATE_DEPRECATION_THRESHOLD` above the current verified count and restart.

---

## Success Criteria

### ✅ All Criteria Met

- [x] **getVerifiedCount()** correctly counts only verified, non-deprecated snippets
- [x] **Threshold gate** reads `TEMPLATE_DEPRECATION_THRESHOLD` with a default of 50
- [x] **Gate ordering** — verified count is checked after snippets are loaded from disk
- [x] **Templates skipped** when verified count >= threshold; clear log message emitted
- [x] **Templates loaded** when below threshold; log includes current count and threshold
- [x] **Tier 3 untouched** — naturally becomes a no-op when `this.templates` is empty
- [x] **YAML files preserved** — no deletion, no rename; documentation only
- [x] **Threshold is tunable** via env var without code changes
- [x] **20/20 validation tests passing** (100% success rate)
- [x] **Zero breaking changes** — behaviour is identical until verified count reaches threshold

---

## Verification

```bash
# Run Phase 5 validation (offline, no server required)
npx tsx server/scripts/validate-phase5.ts

# Force immediate deprecation for testing (threshold = 0)
TEMPLATE_DEPRECATION_THRESHOLD=0 npx tsx server/index.ts

# Keep templates active indefinitely
TEMPLATE_DEPRECATION_THRESHOLD=9999 npx tsx server/index.ts
```

---

*Document Version: 1.0*
*Last Updated: February 1, 2026*
