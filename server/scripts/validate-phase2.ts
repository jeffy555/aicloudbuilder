#!/usr/bin/env tsx
/**
 * Phase 2: Comprehensive Validation Script
 *
 * Validates all Phase 2 deliverables:
 *   Suite 1 — File Structure
 *   Suite 2 — Service Layer (direct DB operations)
 *   Suite 3 — API Endpoints (HTTP)
 *   Suite 4 — Authentication & Authorization
 *   Suite 5 — Business Logic (upsert, confidence, ownership)
 *   Suite 6 — Performance Benchmarks
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { userFixPreferencesStore } from '../rag/user-fix-preferences-store';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Test Infrastructure
// ============================================================

const BASE_URL = 'http://localhost:9005';
const ROOT = path.resolve(__dirname, '..', '..');

interface TestResult {
  suite: string;
  test: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
  durationMs?: number;
}

const allResults: TestResult[] = [];
let currentSuite = '';

function startSuite(name: string) {
  currentSuite = name;
  console.log(`\n${name}`);
  console.log('-'.repeat(70));
}

function record(test: string, passed: boolean, detail?: string, durationMs?: number) {
  const icon = passed ? '✅' : '❌';
  const dur = durationMs !== undefined ? ` (${durationMs}ms)` : '';
  console.log(`  ${icon} ${test}${dur}`);
  if (detail) console.log(`     ${detail}`);
  allResults.push({
    suite: currentSuite,
    test,
    status: passed ? 'PASS' : 'FAIL',
    detail,
    durationMs,
  });
}

// ============================================================
// HTTP helper
// ============================================================

async function api(
  method: string,
  path: string,
  body?: any,
  token?: string | null
): Promise<{ status: number; data: any; durationMs: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts: RequestInit = { method, headers };
  if (body && (method === 'POST' || method === 'PUT')) {
    opts.body = JSON.stringify(body);
  }

  const start = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const durationMs = Date.now() - start;

  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data, durationMs };
}

async function signupUser(): Promise<{ token: string; userId: string }> {
  const ts = Date.now();
  const { data } = await api('POST', '/api/auth/signup', {
    username: `val2_${ts}`,
    email: `val2_${ts}@test.com`,
    password: 'ValidPass1!',
  });
  return { token: data.token, userId: data.user.id };
}

// ============================================================
// Suite 1: File Structure
// ============================================================

async function validateFileStructure() {
  startSuite('📂 Suite 1: File Structure');

  const requiredFiles = [
    { path: 'server/rag/user-fix-preferences-store.ts', minLines: 300 },
    { path: 'server/routes/user-fix-preferences.ts',    minLines: 300 },
    { path: 'server/scripts/test-phase2-api.ts',        minLines: 200 },
    { path: 'docs/PHASE_2_API_DOCS.md',                 minLines: 50 },
    { path: 'docs/PHASE_2_SUMMARY.md',                  minLines: 50 },
  ];

  for (const file of requiredFiles) {
    const full = path.join(ROOT, file.path);
    const exists = fs.existsSync(full);
    if (!exists) {
      record(`File exists: ${file.path}`, false, 'File not found');
      continue;
    }
    const lines = fs.readFileSync(full, 'utf8').split('\n').length;
    record(
      `File exists: ${file.path}`,
      lines >= file.minLines,
      `${lines} lines (min ${file.minLines})`
    );
  }

  // Verify route registration in index.ts
  const indexTs = fs.readFileSync(path.join(ROOT, 'server/routes/index.ts'), 'utf8');
  const hasImport = indexTs.includes('registerUserFixPreferencesRoutes');
  const hasCall = indexTs.includes('registerUserFixPreferencesRoutes(app)');
  record('Route import in index.ts', hasImport, hasImport ? 'Import found' : 'Missing import');
  record('Route registration call', hasCall, hasCall ? 'Registration found' : 'Missing call');

  // Verify requireAuth (not authenticateToken)
  const routeTs = fs.readFileSync(
    path.join(ROOT, 'server/routes/user-fix-preferences.ts'), 'utf8'
  );
  const usesRequireAuth = routeTs.includes('requireAuth');
  const usesAuthenticateToken = routeTs.includes('authenticateToken');
  record(
    'Uses correct auth middleware',
    usesRequireAuth && !usesAuthenticateToken,
    usesAuthenticateToken ? 'Still references authenticateToken!' : 'requireAuth used correctly'
  );
}

// ============================================================
// Suite 2: Service Layer (direct)
// ============================================================

async function validateServiceLayer() {
  startSuite('⚙️  Suite 2: Service Layer');

  // Create a test user directly in the DB for service-layer testing
  const { data: signupData } = await api('POST', '/api/auth/signup', {
    username: `svc_${Date.now()}`,
    email: `svc_${Date.now()}@test.com`,
    password: 'ValidPass1!',
  });
  const testUserId = signupData.user.id;

  // 2.1 storePreference — create new
  let start = Date.now();
  const pref1 = await userFixPreferencesStore.storePreference({
    userId: testUserId,
    checkId: 'CKV_TEST_SVC_1',
    resourceType: 'azurerm_test_resource',
    fixSnippet: 'test_fix = true',
    confidence: 0.80,
    source: 'user_verified',
    timesUsed: 0,
    successCount: 0,
    failureCount: 0,
  });
  record('storePreference (create)', !!pref1?.id, `id: ${pref1?.id}`, Date.now() - start);

  // 2.2 storePreference — upsert (same checkId + resourceType)
  start = Date.now();
  const pref1Updated = await userFixPreferencesStore.storePreference({
    userId: testUserId,
    checkId: 'CKV_TEST_SVC_1',
    resourceType: 'azurerm_test_resource',
    fixSnippet: 'test_fix = false',  // changed
    confidence: 0.90,
    source: 'checkov',
    timesUsed: 0,
    successCount: 0,
    failureCount: 0,
  });
  // Should return same ID (upsert, not new row)
  record(
    'storePreference (upsert)',
    pref1Updated?.id === pref1.id && pref1Updated?.fixSnippet === 'test_fix = false',
    `same id: ${pref1Updated?.id === pref1.id}, snippet updated: ${pref1Updated?.fixSnippet === 'test_fix = false'}`,
    Date.now() - start
  );

  // 2.3 getUserPreference
  start = Date.now();
  const fetched = await userFixPreferencesStore.getUserPreference(
    testUserId, 'CKV_TEST_SVC_1', 'azurerm_test_resource'
  );
  record('getUserPreference', fetched?.id === pref1.id, `found: ${!!fetched}`, Date.now() - start);

  // 2.4 getUserPreferences with pagination
  start = Date.now();
  const list = await userFixPreferencesStore.getUserPreferences(testUserId, 10, 0);
  record('getUserPreferences (pagination)', list.length >= 1, `count: ${list.length}`, Date.now() - start);

  // 2.5 getUserTopFixes
  start = Date.now();
  const top = await userFixPreferencesStore.getUserTopFixes(testUserId, 5);
  record('getUserTopFixes', Array.isArray(top), `count: ${top.length}`, Date.now() - start);

  // 2.6 incrementUsage — success (confidence should go up)
  start = Date.now();
  const beforeConf = fetched!.confidence;
  const afterSuccess = await userFixPreferencesStore.incrementUsage(pref1.id, true);
  const expectedConf = Math.min(1.0, beforeConf + 0.05);
  record(
    'incrementUsage (success)',
    afterSuccess.timesUsed === 1 &&
    afterSuccess.successCount === 1 &&
    Math.abs(afterSuccess.confidence - expectedConf) < 0.001,
    `confidence: ${beforeConf} → ${afterSuccess.confidence} (expected ${expectedConf})`,
    Date.now() - start
  );

  // 2.7 incrementUsage — failure (confidence should go down)
  start = Date.now();
  const beforeConf2 = afterSuccess.confidence;
  const afterFailure = await userFixPreferencesStore.incrementUsage(pref1.id, false);
  const expectedConf2 = Math.max(0.0, beforeConf2 - 0.1);
  record(
    'incrementUsage (failure)',
    afterFailure.timesUsed === 2 &&
    afterFailure.failureCount === 1 &&
    Math.abs(afterFailure.confidence - expectedConf2) < 0.001,
    `confidence: ${beforeConf2} → ${afterFailure.confidence} (expected ${expectedConf2})`,
    Date.now() - start
  );

  // 2.8 getUserStats
  start = Date.now();
  const stats = await userFixPreferencesStore.getUserStats(testUserId);
  record(
    'getUserStats',
    stats.totalPreferences >= 1 && stats.totalUsages >= 2,
    `prefs: ${stats.totalPreferences}, usages: ${stats.totalUsages}, successRate: ${stats.successRate.toFixed(2)}`,
    Date.now() - start
  );

  // 2.9 searchPreferences
  start = Date.now();
  const search = await userFixPreferencesStore.searchPreferences(testUserId, 'CKV_TEST_SVC');
  record('searchPreferences', search.length >= 1, `matches: ${search.length}`, Date.now() - start);

  // 2.10 exists
  start = Date.now();
  const exists = await userFixPreferencesStore.exists(testUserId, 'CKV_TEST_SVC_1', 'azurerm_test_resource');
  const notExists = await userFixPreferencesStore.exists(testUserId, 'CKV_NONEXIST', 'nonexist');
  record('exists()', exists && !notExists, `exists: ${exists}, notExists: ${!notExists}`, Date.now() - start);

  // 2.11 Create a low-confidence preference for cleanup test
  await userFixPreferencesStore.storePreference({
    userId: testUserId,
    checkId: 'CKV_TEST_SVC_LOW',
    resourceType: 'azurerm_low_conf',
    fixSnippet: 'low_conf = true',
    confidence: 0.10,
    source: 'ai_generated',
    timesUsed: 0,
    successCount: 0,
    failureCount: 0,
  });

  // 2.12 getLowConfidencePreferences
  start = Date.now();
  const lowConf = await userFixPreferencesStore.getLowConfidencePreferences(testUserId, 0.5);
  record('getLowConfidencePreferences', lowConf.length >= 1, `found: ${lowConf.length}`, Date.now() - start);

  // 2.13 cleanupLowConfidencePreferences
  start = Date.now();
  const cleaned = await userFixPreferencesStore.cleanupLowConfidencePreferences(testUserId, 0.15);
  record('cleanupLowConfidencePreferences', cleaned >= 1, `cleaned: ${cleaned}`, Date.now() - start);

  // 2.14 deletePreference
  start = Date.now();
  const deleted = await userFixPreferencesStore.deletePreference(pref1.id);
  record('deletePreference', deleted === true, `deleted: ${deleted}`, Date.now() - start);

  // 2.15 deleteUserPreferences (cleanup remaining)
  start = Date.now();
  const delCount = await userFixPreferencesStore.deleteUserPreferences(testUserId);
  record('deleteUserPreferences', delCount >= 0, `deleted: ${delCount}`, Date.now() - start);
}

// ============================================================
// Suite 3: API Endpoints
// ============================================================

async function validateAPIEndpoints() {
  startSuite('🌐 Suite 3: API Endpoints');

  const { token } = await signupUser();

  // POST — create
  let r = await api('POST', '/api/users/me/fix-preferences', {
    checkId: 'CKV_API_TEST_1',
    resourceType: 'azurerm_api_resource',
    fixSnippet: 'api_fix = true',
    confidence: 0.85,
    source: 'user_verified',
    timesUsed: 0,
    successCount: 0,
    failureCount: 0,
  }, token);
  record('POST create (201)', r.status === 201, `status: ${r.status}`, r.durationMs);
  const prefId = r.data?.id;

  // GET — list all
  r = await api('GET', '/api/users/me/fix-preferences', undefined, token);
  record('GET list (200)', r.status === 200 && r.data?.count >= 1, `count: ${r.data?.count}`, r.durationMs);

  // GET — by checkId/resourceType
  r = await api('GET', '/api/users/me/fix-preferences/CKV_API_TEST_1/azurerm_api_resource', undefined, token);
  record('GET by check (200)', r.status === 200 && r.data?.checkId === 'CKV_API_TEST_1', `checkId: ${r.data?.checkId}`, r.durationMs);

  // GET — top
  r = await api('GET', '/api/users/me/fix-preferences/top?limit=5', undefined, token);
  record('GET top (200)', r.status === 200 && 'topFixes' in (r.data || {}), `count: ${r.data?.count}`, r.durationMs);

  // GET — stats
  r = await api('GET', '/api/users/me/fix-preferences/stats', undefined, token);
  record('GET stats (200)', r.status === 200 && 'totalPreferences' in (r.data || {}), `prefs: ${r.data?.totalPreferences}`, r.durationMs);

  // GET — search
  r = await api('GET', '/api/users/me/fix-preferences/search?q=CKV_API', undefined, token);
  record('GET search (200)', r.status === 200 && r.data?.count >= 1, `matches: ${r.data?.count}`, r.durationMs);

  // PUT — update
  r = await api('PUT', `/api/users/me/fix-preferences/${prefId}`, {
    confidence: 0.95,
    source: 'checkov',
  }, token);
  record('PUT update (200)', r.status === 200 && r.data?.confidence === 0.95, `confidence: ${r.data?.confidence}`, r.durationMs);

  // POST — track usage success
  r = await api('POST', `/api/users/me/fix-preferences/${prefId}/use`, { success: true }, token);
  record('POST use/success (200)', r.status === 200 && r.data?.successCount >= 1, `successCount: ${r.data?.successCount}`, r.durationMs);

  // POST — track usage failure
  r = await api('POST', `/api/users/me/fix-preferences/${prefId}/use`, { success: false }, token);
  record('POST use/failure (200)', r.status === 200 && r.data?.failureCount >= 1, `failureCount: ${r.data?.failureCount}`, r.durationMs);

  // GET — low confidence
  r = await api('GET', '/api/users/me/fix-preferences/low-confidence?threshold=0.5', undefined, token);
  record('GET low-confidence (200)', r.status === 200 && 'preferences' in (r.data || {}), `count: ${r.data?.count}`, r.durationMs);

  // POST — cleanup
  r = await api('POST', '/api/users/me/fix-preferences/cleanup', { threshold: 0.01 }, token);
  record('POST cleanup (200)', r.status === 200 && 'count' in (r.data || {}), `cleaned: ${r.data?.count}`, r.durationMs);

  // GET — public endpoint (no auth)
  r = await api('GET', '/api/fix-preferences/check/CKV_API_TEST_1/azurerm_api_resource');
  record('GET public (200)', r.status === 200 && 'fixes' in (r.data || {}), `fixes: ${r.data?.count}`, r.durationMs);

  // DELETE — single
  r = await api('DELETE', `/api/users/me/fix-preferences/${prefId}`, undefined, token);
  record('DELETE single (200)', r.status === 200 && r.data?.success === true, `success: ${r.data?.success}`, r.durationMs);

  // DELETE — all
  r = await api('DELETE', '/api/users/me/fix-preferences', undefined, token);
  record('DELETE all (200)', r.status === 200, `deleted: ${r.data?.count}`, r.durationMs);
}

// ============================================================
// Suite 4: Authentication & Authorization
// ============================================================

async function validateAuthAndAuthz() {
  startSuite('🔐 Suite 4: Authentication & Authorization');

  const { token: ownerToken, userId: ownerId } = await signupUser();
  const { token: otherToken } = await signupUser();

  // Create a preference as owner
  let r = await api('POST', '/api/users/me/fix-preferences', {
    checkId: 'CKV_AUTH_TEST',
    resourceType: 'azurerm_auth_test',
    fixSnippet: 'auth_test = true',
    confidence: 0.9,
    source: 'user_verified',
    timesUsed: 0, successCount: 0, failureCount: 0,
  }, ownerToken);
  const prefId = r.data?.id;

  // 4.1 No auth → 401 on protected endpoints
  r = await api('GET', '/api/users/me/fix-preferences');
  record('No auth → 401 (list)', r.status === 401, `status: ${r.status}`);

  r = await api('GET', '/api/users/me/fix-preferences/stats');
  record('No auth → 401 (stats)', r.status === 401, `status: ${r.status}`);

  r = await api('POST', '/api/users/me/fix-preferences', {
    checkId: 'X', resourceType: 'Y', fixSnippet: 'Z',
    confidence: 0.5, source: 'checkov',
    timesUsed: 0, successCount: 0, failureCount: 0,
  });
  record('No auth → 401 (create)', r.status === 401, `status: ${r.status}`);

  // 4.2 Invalid token → 401
  r = await api('GET', '/api/users/me/fix-preferences', undefined, 'invalid.token.here');
  record('Invalid token → 401', r.status === 401, `status: ${r.status}`);

  // 4.3 Cross-user ownership — other user cannot see owner's preference
  r = await api('GET', '/api/users/me/fix-preferences', undefined, otherToken);
  const otherSeesPref = r.data?.preferences?.some((p: any) => p.id === prefId);
  record('Cross-user list isolation', r.status === 200 && !otherSeesPref, `other sees owner pref: ${otherSeesPref}`);

  // 4.4 Cross-user — cannot update another user's preference
  r = await api('PUT', `/api/users/me/fix-preferences/${prefId}`, { confidence: 0.1 }, otherToken);
  record('Cross-user PUT → 404', r.status === 404, `status: ${r.status}`);

  // 4.5 Cross-user — cannot delete another user's preference
  r = await api('DELETE', `/api/users/me/fix-preferences/${prefId}`, undefined, otherToken);
  record('Cross-user DELETE → 404', r.status === 404, `status: ${r.status}`);

  // 4.6 Cross-user — cannot track usage on another user's preference
  r = await api('POST', `/api/users/me/fix-preferences/${prefId}/use`, { success: true }, otherToken);
  record('Cross-user use → 404', r.status === 404, `status: ${r.status}`);

  // 4.7 Public endpoint works without any token
  r = await api('GET', '/api/fix-preferences/check/CKV_AUTH_TEST/azurerm_auth_test');
  record('Public endpoint (no auth)', r.status === 200, `status: ${r.status}`);

  // Cleanup
  await api('DELETE', '/api/users/me/fix-preferences', undefined, ownerToken);
}

// ============================================================
// Suite 5: Business Logic
// ============================================================

async function validateBusinessLogic() {
  startSuite('🧠 Suite 5: Business Logic');

  const { token } = await signupUser();

  // 5.1 Upsert — POST same checkId+resourceType twice, should not duplicate
  await api('POST', '/api/users/me/fix-preferences', {
    checkId: 'CKV_BIZ_1', resourceType: 'azurerm_biz',
    fixSnippet: 'first = true', confidence: 0.7, source: 'user_verified',
    timesUsed: 0, successCount: 0, failureCount: 0,
  }, token);

  await api('POST', '/api/users/me/fix-preferences', {
    checkId: 'CKV_BIZ_1', resourceType: 'azurerm_biz',
    fixSnippet: 'second = true', confidence: 0.9, source: 'checkov',
    timesUsed: 0, successCount: 0, failureCount: 0,
  }, token);

  const r = await api('GET', '/api/users/me/fix-preferences', undefined, token);
  const bizPrefs = r.data?.preferences?.filter((p: any) => p.checkId === 'CKV_BIZ_1');
  record(
    'Upsert — no duplicates',
    bizPrefs?.length === 1,
    `count for CKV_BIZ_1: ${bizPrefs?.length} (expected 1)`
  );

  if (bizPrefs?.length === 1) {
    record(
      'Upsert — snippet updated',
      bizPrefs[0].fixSnippet === 'second = true',
      `snippet: "${bizPrefs[0].fixSnippet}"`
    );
  }

  const prefId = bizPrefs?.[0]?.id;

  // 5.2 Confidence clamping — drive confidence to max (1.0)
  // First set confidence near max
  await api('PUT', `/api/users/me/fix-preferences/${prefId}`, { confidence: 0.98 }, token);
  let ur = await api('POST', `/api/users/me/fix-preferences/${prefId}/use`, { success: true }, token);
  record(
    'Confidence capped at 1.0',
    ur.data?.confidence === 1.0,
    `confidence after success at 0.98: ${ur.data?.confidence}`
  );

  // 5.3 Confidence clamping — drive confidence to min (0.0)
  await api('PUT', `/api/users/me/fix-preferences/${prefId}`, { confidence: 0.05 }, token);
  ur = await api('POST', `/api/users/me/fix-preferences/${prefId}/use`, { success: false }, token);
  record(
    'Confidence floored at 0.0',
    ur.data?.confidence === 0.0,
    `confidence after failure at 0.05: ${ur.data?.confidence}`
  );

  // 5.4 Validation — missing required fields returns 400
  const vr = await api('POST', '/api/users/me/fix-preferences', {
    checkId: 'ONLY_THIS',
  }, token);
  record('Validation rejects incomplete body (400)', vr.status === 400, `status: ${vr.status}`);

  // 5.5 Validation — invalid confidence out of range
  const vr2 = await api('PUT', `/api/users/me/fix-preferences/${prefId}`, {
    confidence: 5.0,  // out of range
  }, token);
  record('Validation rejects confidence > 1.0 (400)', vr2.status === 400, `status: ${vr2.status}`);

  // 5.6 Usage field must be boolean
  const vr3 = await api('POST', `/api/users/me/fix-preferences/${prefId}/use`, {
    success: 'yes',  // not boolean
  }, token);
  record('Validation rejects non-boolean success (400)', vr3.status === 400, `status: ${vr3.status}`);

  // Cleanup
  await api('DELETE', '/api/users/me/fix-preferences', undefined, token);
}

// ============================================================
// Suite 6: Performance
// ============================================================

async function validatePerformance() {
  startSuite('⏱️  Suite 6: Performance Benchmarks');

  const { token } = await signupUser();
  const THRESHOLD_MS = 150; // all endpoints must respond within 150ms

  // Create a preference first
  await api('POST', '/api/users/me/fix-preferences', {
    checkId: 'CKV_PERF_1', resourceType: 'azurerm_perf',
    fixSnippet: 'perf_test = true', confidence: 0.9, source: 'user_verified',
    timesUsed: 0, successCount: 0, failureCount: 0,
  }, token);

  const benchmarks = [
    { name: 'List preferences',          path: '/api/users/me/fix-preferences' },
    { name: 'Get stats',                 path: '/api/users/me/fix-preferences/stats' },
    { name: 'Get top fixes',             path: '/api/users/me/fix-preferences/top' },
    { name: 'Search preferences',        path: '/api/users/me/fix-preferences/search?q=CKV_PERF' },
    { name: 'Get by check/resource',     path: '/api/users/me/fix-preferences/CKV_PERF_1/azurerm_perf' },
    { name: 'Get low confidence',        path: '/api/users/me/fix-preferences/low-confidence?threshold=0.5' },
    { name: 'Public check lookup',       path: '/api/fix-preferences/check/CKV_PERF_1/azurerm_perf' },
  ];

  let allWithinThreshold = true;

  for (const bench of benchmarks) {
    // Warm-up call
    await api('GET', bench.path, undefined, bench.path.includes('/api/users/') ? token : undefined);

    // Timed call
    const r = await api('GET', bench.path, undefined, bench.path.includes('/api/users/') ? token : undefined);
    const passed = r.status === 200 && r.durationMs < THRESHOLD_MS;
    if (!passed) allWithinThreshold = false;
    record(
      `${bench.name} < ${THRESHOLD_MS}ms`,
      passed,
      `${r.durationMs}ms (status ${r.status})`,
      r.durationMs
    );
  }

  // Cleanup
  await api('DELETE', '/api/users/me/fix-preferences', undefined, token);

  return allWithinThreshold;
}

// ============================================================
// Main
// ============================================================

async function runValidation() {
  console.log('\n🧪 Phase 2: Comprehensive Validation');
  console.log('='.repeat(70));

  await validateFileStructure();
  await validateServiceLayer();
  await validateAPIEndpoints();
  await validateAuthAndAuthz();
  await validateBusinessLogic();
  await validatePerformance();

  // ============================================================
  // Final Report
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('📊 VALIDATION RESULTS');
  console.log('='.repeat(70));

  const passed = allResults.filter(r => r.status === 'PASS').length;
  const failed = allResults.filter(r => r.status === 'FAIL').length;
  const total = allResults.length;
  const pct = ((passed / total) * 100).toFixed(1);

  console.log(`\n  ✅ Passed: ${passed}/${total} (${pct}%)`);
  console.log(`  ❌ Failed: ${failed}/${total}`);

  // Breakdown by suite
  const suites = [...new Set(allResults.map(r => r.suite))];
  console.log('\n  By Suite:');
  for (const suite of suites) {
    const s = allResults.filter(r => r.suite === suite);
    const sp = s.filter(r => r.status === 'PASS').length;
    const icon = sp === s.length ? '✅' : '❌';
    console.log(`    ${icon} ${suite}: ${sp}/${s.length}`);
  }

  // Performance summary
  const perfResults = allResults.filter(r => r.durationMs !== undefined);
  if (perfResults.length > 0) {
    const times = perfResults.map(r => r.durationMs!);
    const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1);
    const max = Math.max(...times);
    const min = Math.min(...times);
    console.log(`\n  ⏱️  Performance: avg ${avg}ms | min ${min}ms | max ${max}ms`);
  }

  if (failed > 0) {
    console.log('\n  ⚠️  Failed Tests:');
    allResults.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`    ❌ [${r.suite}] ${r.test}`);
      if (r.detail) console.log(`       ${r.detail}`);
    });
  }

  console.log('\n' + '='.repeat(70));
  if (passed === total) {
    console.log('🎉 ALL VALIDATIONS PASSED! Phase 2 is fully verified.');
  } else {
    console.log('⚠️  Some validations failed. Review errors above.');
  }

  return passed === total;
}

runValidation()
  .then((success) => { process.exit(success ? 0 : 1); })
  .catch((error) => {
    console.error('\n💥 Validation crashed:', error);
    process.exit(1);
  });
