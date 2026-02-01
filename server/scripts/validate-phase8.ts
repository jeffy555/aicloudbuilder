#!/usr/bin/env tsx
/**
 * Phase 8: End-to-End Activation Smoke Test
 *
 * Traces the full request path from the route entry point through every phase
 * (3–7) to confirm all integration points are correctly connected. Does not
 * boot a server — validates source structure only.
 *
 * Suites:
 *   1. Full Request-Path Trace  — route → wrapper → retriever → tiers → store
 *   2. Verification Feedback Loop — success/failure → storeVerifiedFix / reportFixFailure
 *   3. Feature Flag Activation Sequence — all flags present and independently controllable
 *   4. Multi-Cloud Readiness — cloudProvider flows end-to-end, no hardcoded providers
 *   5. Phase Continuity — each phase's key artifact is still present and unbroken
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// --- Test infrastructure ---

interface TestResult {
  suite: string;
  test: string;
  status: 'PASS' | 'FAIL';
  error?: string;
}

const results: TestResult[] = [];
let currentSuite = '';

function record(test: string, passed: boolean, error?: string) {
  const result: TestResult = {
    suite: currentSuite,
    test,
    status: passed ? 'PASS' : 'FAIL',
    error: passed ? undefined : error,
  };
  results.push(result);
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} ${test}${error ? ` — ${error}` : ''}`);
}

function suite(name: string) {
  currentSuite = name;
  console.log(`\n📋 ${name}`);
  console.log('  ' + '-'.repeat(60));
}

// --- Source files ---

let routesSource = '';
let retrieverSource = '';
let ragSource = '';
let storeSource = '';
let flagsSource = '';
let cacheSource = '';
let fetcherSource = '';
let envContent = '';

async function loadSources(): Promise<void> {
  routesSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'routes-legacy.ts'), 'utf-8'
  );
  retrieverSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'intelligent-fix-retriever.ts'), 'utf-8'
  );
  ragSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'remediation-rag.ts'), 'utf-8'
  );
  storeSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'fix-snippet-store.ts'), 'utf-8'
  );
  flagsSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'middleware', 'feature-flags.ts'), 'utf-8'
  );
  cacheSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'checkov-cache.ts'), 'utf-8'
  );
  fetcherSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'checkov-fetcher.ts'), 'utf-8'
  );
  envContent = await fs.readFile(
    path.join(PROJECT_ROOT, '.env'), 'utf-8'
  );
}

// --- Suite 1: Full Request-Path Trace ---

async function testRequestPathTrace() {
  suite('Suite 1: Full Request-Path Trace');

  // Step 1: Route entry — POST /api/sessions/:id/fix-issues exists
  record(
    'Route entry: fix-issues endpoint defined',
    routesSource.includes('app.post("/api/sessions/:id/fix-issues"')
  );

  // Step 2: Route calls getRemediation wrapper (not remediationRAGService directly)
  const getRemediationCalls = (routesSource.match(/await getRemediation\(/g) || []).length;
  record(
    'Route uses getRemediation wrapper (3 call sites)',
    getRemediationCalls === 3,
    getRemediationCalls !== 3 ? `Expected 3 calls, found ${getRemediationCalls}` : undefined
  );

  // Step 3: getRemediation gates on intelligentFixRetrieval flag
  record(
    'Wrapper gates on featureFlags.intelligentFixRetrieval',
    routesSource.includes('featureFlags.intelligentFixRetrieval') &&
    routesSource.includes('intelligentFixRetriever.getFixForCheck(')
  );

  // Step 4: getFixForCheck calls getTier1, getTier2, getTier3to5
  record(
    'getFixForCheck calls Tier 1 (user preference)',
    retrieverSource.includes('this.getTier1UserPreference(')
  );
  record(
    'getFixForCheck calls Tier 2 (Checkov native)',
    retrieverSource.includes('this.getTier2CheckovNative(')
  );
  record(
    'getFixForCheck calls Tier 3-5 (RAG waterfall)',
    retrieverSource.includes('this.getTier3to5ExistingRAG(')
  );

  // Step 5: Tier 3-5 delegates to remediationRAGService.findRemediation
  record(
    'Tier 3-5 delegates to remediationRAGService.findRemediation',
    retrieverSource.includes('remediationRAGService.findRemediation(')
  );

  // Step 6: RAG waterfall has all 5 tiers
  record(
    'RAG waterfall contains Tier 1 through Tier 5 labels',
    ragSource.includes('Tier 1:') &&
    ragSource.includes('Tier 2:') &&
    ragSource.includes('Tier 3:') &&
    ragSource.includes('Tier 4:') &&
    ragSource.includes('Tier 5:')
  );

  // Step 7: Tier 2 (Checkov native) uses checkovFetcher
  record(
    'Tier 2 uses checkovFetcher.fetchRemediation',
    retrieverSource.includes('checkovFetcher.fetchRemediation(')
  );

  // Step 8: Checkov fetcher uses checkov cache
  record(
    'checkov-fetcher.ts exists and has fetchRemediation',
    fetcherSource.includes('fetchRemediation') && fetcherSource.length > 100
  );

  // Step 9: Fix snippet store is used for Tier 1 exact match
  record(
    'fix-snippet-store.ts has getByKey for exact match lookup',
    storeSource.includes('async getByKey(')
  );
}

// --- Suite 2: Verification Feedback Loop ---

async function testVerificationLoop() {
  suite('Suite 2: Verification Feedback Loop');

  // Success path: storeVerifiedFix called when flag is on
  record(
    'Success: storeVerifiedFix called under intelligentFixRetrieval gate',
    routesSource.includes('intelligentFixRetriever.storeVerifiedFix(') &&
    routesSource.includes('featureFlags.intelligentFixRetrieval')
  );

  // Failure path: reportFixFailure called when flag is on
  record(
    'Failure: reportFixFailure called under intelligentFixRetrieval gate',
    routesSource.includes('intelligentFixRetriever.reportFixFailure(')
  );

  // storeVerifiedFix updates global snippet store
  record(
    'storeVerifiedFix updates global store via updateFixFromVerification',
    retrieverSource.includes('remediationRAGService.updateFixFromVerification(existingSnippet.id, verified)')
  );

  // storeVerifiedFix updates user preference when flag on
  record(
    'storeVerifiedFix stores user preference when userFixPreferences enabled',
    retrieverSource.includes('featureFlags.userFixPreferences') &&
    retrieverSource.includes('userFixPreferencesStore.storePreference(')
  );

  // reportFixFailure decrements user preference
  const reportBody = retrieverSource.substring(
    retrieverSource.indexOf('async reportFixFailure('),
    retrieverSource.indexOf('}\n}\n')
  );
  record(
    'reportFixFailure decrements user preference via incrementUsage(id, false)',
    reportBody.includes('incrementUsage(pref.id, false)')
  );

  // reportFixFailure decrements global snippet
  record(
    'reportFixFailure decrements global snippet via updateFixFromVerification(id, false)',
    reportBody.includes('updateFixFromVerification(globalSnippet.id, false)')
  );

  // Legacy paths preserved in else branches
  record(
    'Legacy success path (updateFixFromVerification true) preserved',
    routesSource.includes('remediationRAGService.updateFixFromVerification(snippet.id, true)')
  );
  record(
    'Legacy failure path (updateFixFromVerification false) preserved',
    routesSource.includes('remediationRAGService.updateFixFromVerification(snippet.id, false)')
  );
}

// --- Suite 3: Feature Flag Activation Sequence ---

async function testFeatureFlagSequence() {
  suite('Suite 3: Feature Flag Activation Sequence');

  // All 3 intelligent-system flags exist in feature-flags.ts
  record(
    'userFixPreferences flag defined',
    flagsSource.includes("userFixPreferences:") &&
    flagsSource.includes("ENABLE_USER_FIX_PREFERENCES")
  );
  record(
    'checkovNativeFetch flag defined',
    flagsSource.includes("checkovNativeFetch:") &&
    flagsSource.includes("ENABLE_CHECKOV_NATIVE_FETCH")
  );
  record(
    'intelligentFixRetrieval flag defined',
    flagsSource.includes("intelligentFixRetrieval:") &&
    flagsSource.includes("ENABLE_INTELLIGENT_FIX_RETRIEVAL")
  );

  // All 3 flags default to false in .env
  record(
    '.env: ENABLE_USER_FIX_PREFERENCES=false',
    envContent.includes('ENABLE_USER_FIX_PREFERENCES=false')
  );
  record(
    '.env: ENABLE_CHECKOV_NATIVE_FETCH=false',
    envContent.includes('ENABLE_CHECKOV_NATIVE_FETCH=false')
  );
  record(
    '.env: ENABLE_INTELLIGENT_FIX_RETRIEVAL=false',
    envContent.includes('ENABLE_INTELLIGENT_FIX_RETRIEVAL=false')
  );

  // Flags are independently checked (not ANDed together in one condition)
  // intelligentFixRetrieval is checked in the wrapper
  // userFixPreferences is checked inside Tier 1
  // checkovNativeFetch is checked inside Tier 2
  record(
    'Flags are independently gated (each checked at its own tier)',
    retrieverSource.includes('featureFlags.userFixPreferences') &&
    retrieverSource.includes('featureFlags.checkovNativeFetch') &&
    routesSource.includes('featureFlags.intelligentFixRetrieval')
  );

  // reloadFeatureFlags exists for runtime toggling
  record(
    'reloadFeatureFlags() available for runtime flag changes',
    flagsSource.includes('export function reloadFeatureFlags()')
  );
}

// --- Suite 4: Multi-Cloud Readiness ---

async function testMultiCloudReadiness() {
  suite('Suite 4: Multi-Cloud Readiness');

  // cloudProvider threaded through getRemediation
  record(
    'getRemediation wrapper accepts cloudProvider',
    routesSource.includes('async function getRemediation(') &&
    routesSource.match(/async function getRemediation\([^)]*cloudProvider[^)]*\)/) !== null
  );

  // cloudProvider threaded through getFixForCheck
  record(
    'getFixForCheck accepts cloudProvider',
    retrieverSource.match(/async getFixForCheck\([^)]*cloudProvider[^)]*\)/) !== null
  );

  // cloudProvider threaded through storeVerifiedFix
  record(
    'storeVerifiedFix accepts cloudProvider',
    retrieverSource.match(/async storeVerifiedFix\([^)]*cloudProvider[^)]*\)/) !== null
  );

  // Only one fallback default point (storeInGlobalCache)
  const azureOccurrences = retrieverSource.split('\n').filter(
    l => l.includes("'azure'") && !l.includes("|| 'azure'") && !l.includes('//')
  );
  record(
    'Single fallback point: only storeInGlobalCache uses || azure default',
    azureOccurrences.length === 0,
    azureOccurrences.length > 0
      ? `Found bare 'azure' on ${azureOccurrences.length} line(s)`
      : undefined
  );

  // session.cloudProvider is passed at all call sites
  const cloudProviderAtCallSites = (routesSource.match(/await getRemediation\([\s\S]*?\)/g) || [])
    .filter(c => c.includes("session.cloudProvider"));
  record(
    'All 3 call sites pass session.cloudProvider',
    cloudProviderAtCallSites.length === 3,
    cloudProviderAtCallSites.length !== 3
      ? `Expected 3, found ${cloudProviderAtCallSites.length}`
      : undefined
  );
}

// --- Suite 5: Phase Continuity ---

async function testPhaseContinuity() {
  suite('Suite 5: Phase Continuity');

  // Phase 3: 5-tier waterfall labels present in remediation-rag.ts
  record(
    'Phase 3: 5-tier waterfall in remediation-rag.ts',
    ragSource.includes('Tier 1:') && ragSource.includes('Tier 5:')
  );

  // Phase 3: checkov-cache.ts and checkov-fetcher.ts exist with expected exports
  record(
    'Phase 3: checkov-cache.ts exports CheckovCache',
    cacheSource.includes('export') && cacheSource.includes('CheckovCache')
  );
  record(
    'Phase 3: checkov-fetcher.ts exports checkovFetcher',
    fetcherSource.includes('export') && fetcherSource.includes('checkovFetcher')
  );

  // Phase 4: IntelligentFixRetriever class + singleton exported
  record(
    'Phase 4: IntelligentFixRetriever class exported',
    retrieverSource.includes('export class IntelligentFixRetriever')
  );
  record(
    'Phase 4: intelligentFixRetriever singleton exported',
    retrieverSource.includes('export const intelligentFixRetriever = new IntelligentFixRetriever()')
  );

  // Phase 5: getVerifiedCount + threshold gate
  record(
    'Phase 5: getVerifiedCount() in fix-snippet-store.ts',
    storeSource.includes('getVerifiedCount()')
  );
  record(
    'Phase 5: TEMPLATE_DEPRECATION_THRESHOLD in .env',
    envContent.includes('TEMPLATE_DEPRECATION_THRESHOLD=50')
  );
  record(
    'Phase 5: Threshold gate in remediation-rag.ts initialize()',
    ragSource.includes('verifiedCount >= deprecationThreshold')
  );

  // Phase 6: getRemediation wrapper + imports
  record(
    'Phase 6: getRemediation wrapper defined in routes-legacy.ts',
    routesSource.includes('async function getRemediation(')
  );
  record(
    'Phase 6: intelligentFixRetriever imported in routes-legacy.ts',
    routesSource.includes('import { intelligentFixRetriever }')
  );

  // Phase 7: TODO removed, cloudProvider threaded
  record(
    'Phase 7: No dangling TODO in intelligent-fix-retriever.ts',
    !retrieverSource.includes('TODO')
  );
  record(
    'Phase 7: cloudProvider param in storeInGlobalCache',
    retrieverSource.match(/private async storeInGlobalCache\([^)]*cloudProvider[^)]*\)/) !== null
  );
}

// --- Main ---

async function runValidation() {
  console.log('\n🧪 Phase 8: End-to-End Activation Smoke Test — Validation\n');
  console.log('='.repeat(70));

  await loadSources();

  await testRequestPathTrace();
  await testVerificationLoop();
  await testFeatureFlagSequence();
  await testMultiCloudReadiness();
  await testPhaseContinuity();

  // --- Final Report ---
  console.log('\n' + '='.repeat(70));
  console.log('📊 VALIDATION RESULTS');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;
  const successRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';

  console.log(`\n✅ Passed: ${passed}/${total} (${successRate}%)`);
  console.log(`❌ Failed: ${failed}/${total}`);

  if (failed > 0) {
    console.log('\n⚠️  Failed Tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`   [${r.suite}] ${r.test}: ${r.error}`);
    });
  }

  // Suite breakdown
  console.log('\n📂 By Suite:');
  const suites = [...new Set(results.map(r => r.suite))];
  for (const s of suites) {
    const suiteResults = results.filter(r => r.suite === s);
    const sp = suiteResults.filter(r => r.status === 'PASS').length;
    const icon = sp === suiteResults.length ? '✅' : '❌';
    console.log(`   ${icon} ${s}: ${sp}/${suiteResults.length}`);
  }

  console.log('\n' + '='.repeat(70));
  if (passed === total) {
    console.log('🎉 ALL TESTS PASSED! The intelligent fix system is ready for activation.');
  } else {
    console.log('⚠️  Some tests failed. Review errors above.');
  }

  return passed === total;
}

runValidation()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error('\n💥 Validation crashed:', error);
    process.exit(1);
  });
