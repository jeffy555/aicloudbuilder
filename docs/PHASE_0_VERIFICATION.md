# Phase 0 Verification Guide

This guide walks you through verifying that Phase 0 is correctly implemented and working.

---

## Quick Verification (5 minutes)

Run these commands in sequence to verify Phase 0 is working:

```bash
# 1. Check baseline analysis works
npx tsx server/scripts/baseline-analysis.ts

# 2. Start the server
npm run dev

# 3. In another terminal, test metrics endpoints
curl http://localhost:9005/api/metrics/feature-flags
curl http://localhost:9005/api/metrics/dashboard
curl http://localhost:9005/api/metrics/performance
```

**Expected Results:**
- ✅ Baseline analysis generates reports
- ✅ Server starts with feature flag status displayed
- ✅ All metrics endpoints return JSON data

---

## Detailed Verification Steps

### Step 1: Verify Baseline Analysis Script

**Command:**
```bash
npx tsx server/scripts/baseline-analysis.ts
```

**Expected Output:**
```
📊 Starting baseline analysis...

🔍 Analyzing fix logs...
   Found 0 fix operations
🔍 Analyzing fix snippets...
   Found 30 fix snippets (2 active)
🔍 Analyzing embedding cache...
   Found 134 cached embeddings
🔍 Analyzing Checkov coverage...
   Covering 0 unique Checkov checks
🔍 Calculating cache sizes...

======================================================================
📊 BASELINE METRICS REPORT
======================================================================
Generated: [timestamp]

🤖 AI API CALLS (Embeddings)
──────────────────────────────────────────────────────────────────────
   Total embedding calls: 134
   OpenAI API calls: 0
   Fallback calls: 0
   Cache effectiveness: 100% saved
   Est. monthly cost: $0.000

... [more output]

✅ Baseline metrics saved to: d:\AICloudBuilder\docs\metrics\baseline-metrics.json
✅ Markdown report saved to: d:\AICloudBuilder\docs\metrics\baseline-report.md

✅ Baseline analysis complete!
```

**Verify Files Created:**
```bash
# Check that report files were created
ls -lh docs/metrics/baseline-metrics.json
ls -lh docs/metrics/baseline-report.md

# View the JSON report
cat docs/metrics/baseline-metrics.json | jq
```

**✅ Success Criteria:**
- Script runs without errors
- JSON and Markdown files created
- Metrics show reasonable values (embeddings > 0, cache size > 0)

---

### Step 2: Verify Server Startup with Feature Flags

**Command:**
```bash
npm run dev
```

**Expected Output (look for this section):**
```
🚩 Feature Flags Status:
============================================================
  User Fix Preferences:     ❌ DISABLED
  Checkov Native Fetch:     ❌ DISABLED
  Intelligent Fix Retrieval: ❌ DISABLED
  Performance Logging:      ✅ ENABLED
  Metrics Dashboard:        ✅ ENABLED
============================================================

🔍 Initializing Remediation RAG Service...
💾 Embedding cache: 134 cached embedding(s) loaded
📚 Loaded 30 fix snippet(s)
   Active: 2, Deprecated: 28
✅ Remediation RAG Service initialized

serving on port 9005
```

**✅ Success Criteria:**
- Feature flags displayed on startup
- Performance Logging: ✅ ENABLED
- Metrics Dashboard: ✅ ENABLED
- RAG service initializes successfully
- Server starts on port 9005

---

### Step 3: Verify Metrics Endpoints

#### 3.1: Feature Flags Status

**Command:**
```bash
curl http://localhost:9005/api/metrics/feature-flags | jq
```

**Expected Response:**
```json
{
  "features": {
    "userFixPreferences": false,
    "checkovNativeFetch": false,
    "intelligentFixRetrieval": false,
    "performanceLogging": true,
    "metricsDashboard": true
  },
  "timestamp": "2026-01-31T..."
}
```

**✅ Success Criteria:**
- Returns valid JSON
- All flags present
- `performanceLogging` and `metricsDashboard` are `true`
- Others are `false` (safe defaults)

---

#### 3.2: Dashboard Overview

**Command:**
```bash
curl http://localhost:9005/api/metrics/dashboard | jq
```

**Expected Response:**
```json
{
  "overview": {
    "totalOperations": 0,
    "operationTypes": 0,
    "averageResponseMs": "0.00",
    "successRate": "0.0%",
    "activeOperations": 0
  },
  "fixRetrieval": {
    "findRemediation": null,
    "exactMatch": null,
    "semanticSearch": null
  },
  "cache": {
    "fixSnippets": {
      "total": 30,
      "active": 2,
      "deprecated": 28,
      "verified": 0,
      "bySource": {...}
    },
    "vectorStoreSize": 147
  },
  "aiUsage": null,
  "timestamp": "2026-01-31T..."
}
```

**✅ Success Criteria:**
- Returns valid JSON
- Cache stats show fix snippets loaded
- Vector store size > 0
- No errors

---

#### 3.3: Performance Metrics

**Command:**
```bash
curl http://localhost:9005/api/metrics/performance | jq
```

**Expected Response:**
```json
{
  "summary": {
    "totalOperations": 0,
    "operationTypes": 0,
    "averageDurationMs": 0,
    "successRate": 0,
    "activeOperations": 0
  },
  "stats": [],
  "timestamp": "2026-01-31T..."
}
```

**Note:** Stats will be empty until operations are performed. This is normal.

**✅ Success Criteria:**
- Returns valid JSON
- Summary object present
- No errors

---

#### 3.4: Cache Statistics

**Command:**
```bash
curl http://localhost:9005/api/metrics/cache | jq
```

**Expected Response:**
```json
{
  "fixSnippets": {
    "total": 30,
    "active": 2,
    "deprecated": 28,
    "verified": 0,
    "bySource": {...},
    "fileSizeBytes": 125849,
    "fileSizeMB": "0.12"
  },
  "vectorStore": {
    "size": 147,
    "fileSizeBytes": 4520000,
    "fileSizeMB": "4.31"
  },
  "fixLogs": {
    "fileSizeBytes": 410112,
    "fileSizeMB": "0.39"
  },
  "totalCacheSizeMB": "4.82",
  "timestamp": "2026-01-31T..."
}
```

**✅ Success Criteria:**
- Returns valid JSON
- File sizes > 0
- Total cache size reasonable (~5 MB)

---

#### 3.5: AI Usage & Cost Tracking

**Command:**
```bash
curl http://localhost:9005/api/metrics/ai-usage | jq
```

**Expected Response:**
```json
{
  "embeddings": {
    "total": 134,
    "openai": 0,
    "fallback": 0,
    "cacheHits": 134,
    "cacheHitRate": "100.0%"
  },
  "performance": null,
  "cost": {
    "totalCost": "$0.000000",
    "totalTokensUsed": 0,
    "savedFromCache": "$0.000536",
    "estimatedMonthlyCost": "$0.000"
  },
  "timestamp": "2026-01-31T..."
}
```

**✅ Success Criteria:**
- Returns valid JSON
- Cache hit rate shown
- Cost tracking initialized

---

#### 3.6: Baseline Report

**Command:**
```bash
curl http://localhost:9005/api/metrics/baseline | jq
```

**Expected Response:**
```json
{
  "timestamp": "2026-01-31T...",
  "aiApiCalls": {
    "totalEmbeddingCalls": 134,
    "openaiCalls": 0,
    "fallbackCalls": 0,
    "cacheHitRate": 100,
    "estimatedMonthlyCost": 0
  },
  "fixRetrieval": {...},
  "successRate": {...},
  "checkovCoverage": {...},
  "cacheStats": {...}
}
```

**✅ Success Criteria:**
- Returns the baseline metrics from Step 1
- All sections present
- No 404 error

---

### Step 4: Verify Performance Logging

To verify performance logging is working, we need to trigger some operations.

**Trigger a RAG lookup:**
```bash
# Start the server (if not already running)
npm run dev

# In the application:
# 1. Create a session
# 2. Generate some Terraform code
# 3. Run a Checkov scan
```

**Then check performance metrics:**
```bash
curl http://localhost:9005/api/metrics/performance | jq
```

**Expected Response (after operations):**
```json
{
  "summary": {
    "totalOperations": 5,
    "operationTypes": 3,
    "averageDurationMs": 123.45,
    "successRate": 1,
    "activeOperations": 0
  },
  "stats": [
    {
      "operation": "findRemediation",
      "count": 2,
      "totalDurationMs": 234.56,
      "averageDurationMs": 117.28,
      "minDurationMs": 95,
      "maxDurationMs": 139,
      "successCount": 2,
      "failureCount": 0
    },
    ...
  ],
  "timestamp": "2026-01-31T..."
}
```

**✅ Success Criteria:**
- After operations, stats array has entries
- Operations are being tracked
- Timing data looks reasonable (not 0)

---

### Step 5: Verify Feature Flag Toggle

Test that feature flags can be toggled.

**Disable Performance Logging:**
```bash
# Edit .env file
# Change: ENABLE_PERFORMANCE_LOGGING=false

# Restart server
# Ctrl+C to stop
npm run dev
```

**Expected Output:**
```
🚩 Feature Flags Status:
============================================================
  ...
  Performance Logging:      ❌ DISABLED
  ...
============================================================
```

**Re-enable:**
```bash
# Edit .env file
# Change: ENABLE_PERFORMANCE_LOGGING=true

# Restart server
npm run dev
```

**✅ Success Criteria:**
- Feature flag changes reflected on restart
- Server adapts to flag changes
- No errors when toggling

---

### Step 6: Verify TypeScript Compilation

**Command:**
```bash
cd server
npm run build
```

**Expected Output:**
```
> rest-express@1.0.0 build
> vite build && esbuild server/index.ts ...

vite v5.4.20 building for production...
✓ 3674 modules transformed.
...
✓ built in [time]
```

**✅ Success Criteria:**
- Build completes without errors
- No TypeScript errors
- All new files compile successfully

---

### Step 7: Verify Rollback Procedures

**Test Emergency Rollback:**
```bash
# 1. Create backup branch
git branch phase-0-backup

# 2. Disable all features
# Edit .env:
ENABLE_PERFORMANCE_LOGGING=false
ENABLE_METRICS_DASHBOARD=false

# 3. Restart server
npm run dev
```

**Expected Output:**
```
🚩 Feature Flags Status:
============================================================
  ...
  Performance Logging:      ❌ DISABLED
  Metrics Dashboard:        ❌ DISABLED
============================================================
```

**Test metrics endpoint disabled:**
```bash
curl http://localhost:9005/api/metrics/dashboard
# Should still work (routes registered regardless)
```

**Restore:**
```bash
# Edit .env back to:
ENABLE_PERFORMANCE_LOGGING=true
ENABLE_METRICS_DASHBOARD=true

# Restart
npm run dev
```

**✅ Success Criteria:**
- Can disable features via .env
- Server continues to run
- Easy to revert changes

---

## Verification Checklist

Use this checklist to ensure Phase 0 is complete:

### Baseline Analysis
- [ ] Baseline script runs without errors
- [ ] JSON report generated at `docs/metrics/baseline-metrics.json`
- [ ] Markdown report generated at `docs/metrics/baseline-report.md`
- [ ] Reports show cache statistics (>0 MB)

### Server Startup
- [ ] Server starts without errors
- [ ] Feature flags displayed on startup
- [ ] Performance Logging: ✅ ENABLED
- [ ] Metrics Dashboard: ✅ ENABLED
- [ ] RAG service initializes successfully

### Metrics Endpoints
- [ ] `/api/metrics/feature-flags` returns JSON
- [ ] `/api/metrics/dashboard` returns JSON
- [ ] `/api/metrics/performance` returns JSON
- [ ] `/api/metrics/cache` returns JSON
- [ ] `/api/metrics/ai-usage` returns JSON
- [ ] `/api/metrics/baseline` returns JSON
- [ ] All endpoints respond within 100ms

### Performance Logging
- [ ] Performance logger tracks operations
- [ ] Stats accumulate after operations
- [ ] Timing data looks reasonable
- [ ] Success/failure tracking works

### Feature Flags
- [ ] All 5 flags present in `.env`
- [ ] Flags displayed on server startup
- [ ] Can toggle flags and restart
- [ ] Server adapts to flag changes

### Documentation
- [ ] `ROLLBACK_PROCEDURES.md` exists
- [ ] `PHASE_0_SUMMARY.md` exists
- [ ] Baseline reports exist

### Build & Compilation
- [ ] `npm run build` succeeds
- [ ] No TypeScript errors
- [ ] No linting errors

### Rollback Testing
- [ ] Can disable all features
- [ ] Server continues to run
- [ ] Easy to revert changes
- [ ] Rollback procedures documented

---

## Troubleshooting

### Issue: Baseline script fails

**Error:** `Cannot find module 'tsx'`
```bash
npm install -g tsx
# Or use npx:
npx tsx server/scripts/baseline-analysis.ts
```

**Error:** `ENOENT: no such file or directory, open '.cache/...'`
```bash
# Cache files don't exist yet - run server first to generate them
npm run dev
# Then run baseline analysis
npx tsx server/scripts/baseline-analysis.ts
```

---

### Issue: Metrics endpoints return 404

**Check routes registered:**
```bash
# Look for this in server logs on startup:
grep "registerMetricsRoutes" server/routes/index.ts
```

**Verify server is running:**
```bash
curl http://localhost:9005/api/health
```

---

### Issue: Feature flags not changing

**Check .env file:**
```bash
cat .env | grep ENABLE_
```

**Restart server:**
```bash
# Ctrl+C to stop
npm run dev
```

**Note:** `.env` changes require server restart

---

### Issue: Performance metrics show 0 operations

**This is normal on fresh start!**

Performance metrics will be empty until you:
1. Create a session
2. Generate Terraform code
3. Run Checkov scans
4. Apply fixes

Then check again:
```bash
curl http://localhost:9005/api/metrics/performance | jq
```

---

## Success Indicators

You've successfully verified Phase 0 if:

✅ All 8 metrics endpoints respond
✅ Feature flags show on startup
✅ Baseline reports generated
✅ TypeScript compiles without errors
✅ Server runs without warnings
✅ All checklist items marked complete

---

## Next: Phase 1

Once all verification steps pass, you're ready for Phase 1!

```bash
# Phase 1 starts with database migration
# See implementation plan for details
```

---

*Last Updated: January 31, 2026*
