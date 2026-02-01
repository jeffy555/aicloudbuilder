#!/usr/bin/env tsx
/**
 * Phase 7: Validation Script
 *
 * Validates that the cloud provider is correctly threaded through the intelligent
 * fix path: getRemediation() → getFixForCheck() → getTier2CheckovNative() →
 * storeInGlobalCache(), and through storeVerifiedFix() on the verification path.
 * Confirms the Phase 4 TODO is removed and no hardcoded 'azure' remains in the
 * intelligent path (fallback defaults are acceptable).
 * Does NOT require a running server or database.
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

// --- Shared source reads ---

let routesSource = '';
let retrieverSource = '';

async function loadSources(): Promise<void> {
  routesSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'routes-legacy.ts'), 'utf-8'
  );
  retrieverSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'intelligent-fix-retriever.ts'), 'utf-8'
  );
}

// --- Suite 1: TODO Removal ---

async function testTodoRemoval() {
  suite('Suite 1: TODO Removal');

  // The Phase 4 TODO comment is gone
  record(
    'Phase 4 TODO removed from storeInGlobalCache',
    !retrieverSource.includes('TODO: thread cloud provider'),
    retrieverSource.includes('TODO: thread cloud provider')
      ? 'TODO comment still present'
      : undefined
  );

  // No bare hardcoded 'azure' string remains (only fallback defaults like cloudProvider || 'azure' are allowed)
  // Count occurrences of standalone 'azure' (not preceded by || or &&)
  const bareAzure = retrieverSource.match(/'azure'(?!\s*[,\)])/g) || [];
  // Filter: only flag lines that are NOT fallback defaults (i.e. lines without || before 'azure')
  const lines = retrieverSource.split('\n');
  const hardcodedLines = lines.filter(line =>
    line.includes("'azure'") && !line.includes("|| 'azure'") && !line.includes("// ")
  );
  record(
    'No hardcoded azure string outside fallback defaults',
    hardcodedLines.length === 0,
    hardcodedLines.length > 0
      ? `Found hardcoded 'azure' on ${hardcodedLines.length} line(s): ${hardcodedLines.map(l => l.trim()).join(' | ')}`
      : undefined
  );
}

// --- Suite 2: getFixForCheck Signature ---

async function testGetFixForCheckSignature() {
  suite('Suite 2: getFixForCheck Signature');

  // cloudProvider parameter added to getFixForCheck
  record(
    'getFixForCheck has cloudProvider parameter',
    retrieverSource.includes('cloudProvider?: string') &&
    retrieverSource.indexOf('cloudProvider?: string') > retrieverSource.indexOf('async getFixForCheck('),
    !(retrieverSource.includes('cloudProvider?: string') &&
      retrieverSource.indexOf('cloudProvider?: string') > retrieverSource.indexOf('async getFixForCheck('))
      ? 'cloudProvider parameter not found in getFixForCheck'
      : undefined
  );

  // cloudProvider is threaded to getTier2CheckovNative call
  record(
    'getFixForCheck threads cloudProvider to getTier2CheckovNative',
    retrieverSource.includes('this.getTier2CheckovNative(checkId, resourceType, guideline, cloudProvider)'),
    !retrieverSource.includes('this.getTier2CheckovNative(checkId, resourceType, guideline, cloudProvider)')
      ? 'cloudProvider not passed to getTier2CheckovNative'
      : undefined
  );

  // Log message includes cloudProvider
  record(
    'getFixForCheck log includes cloud provider',
    retrieverSource.includes('provider: ${cloudProvider'),
    !retrieverSource.includes('provider: ${cloudProvider')
      ? 'Log message does not include cloudProvider'
      : undefined
  );
}

// --- Suite 3: getTier2CheckovNative Threading ---

async function testTier2Threading() {
  suite('Suite 3: getTier2CheckovNative Threading');

  // getTier2CheckovNative has cloudProvider parameter
  const tier2Match = retrieverSource.match(/private async getTier2CheckovNative\([^)]*cloudProvider[^)]*\)/);
  record(
    'getTier2CheckovNative accepts cloudProvider parameter',
    tier2Match !== null,
    tier2Match === null
      ? 'cloudProvider parameter not found in getTier2CheckovNative signature'
      : undefined
  );

  // getTier2CheckovNative threads cloudProvider to storeInGlobalCache
  // The call inside Tier 2 should pass cloudProvider as the last arg
  const tier2Body = retrieverSource.substring(
    retrieverSource.indexOf('private async getTier2CheckovNative('),
    retrieverSource.indexOf('private async getTier3to5ExistingRAG(')
  );
  record(
    'Tier 2 threads cloudProvider to storeInGlobalCache',
    tier2Body.includes('inferred.confidence, cloudProvider)'),
    !tier2Body.includes('inferred.confidence, cloudProvider)')
      ? 'cloudProvider not passed to storeInGlobalCache in Tier 2'
      : undefined
  );
}

// --- Suite 4: storeInGlobalCache ---

async function testStoreInGlobalCache() {
  suite('Suite 4: storeInGlobalCache');

  // storeInGlobalCache has cloudProvider parameter
  const storeMatch = retrieverSource.match(/private async storeInGlobalCache\([^)]*cloudProvider[^)]*\)/);
  record(
    'storeInGlobalCache accepts cloudProvider parameter',
    storeMatch !== null,
    storeMatch === null
      ? 'cloudProvider parameter not found in storeInGlobalCache signature'
      : undefined
  );

  // Uses cloudProvider || 'azure' as fallback (not bare 'azure')
  const storeBody = retrieverSource.substring(
    retrieverSource.indexOf('private async storeInGlobalCache('),
    retrieverSource.indexOf('console.log(`💾 Stored fix in global cache')
  );
  record(
    'storeInGlobalCache uses cloudProvider || azure fallback',
    storeBody.includes("cloudProvider || 'azure'"),
    !storeBody.includes("cloudProvider || 'azure'")
      ? "Fallback pattern cloudProvider || 'azure' not found"
      : undefined
  );

  // The bare 'azure' without || is gone from storeInGlobalCache body
  record(
    'No bare hardcoded azure in storeInGlobalCache body',
    !storeBody.includes("'azure',") || storeBody.includes("cloudProvider || 'azure',"),
    storeBody.includes("'azure',") && !storeBody.includes("cloudProvider || 'azure',")
      ? "Bare 'azure' string still present in storeInGlobalCache"
      : undefined
  );
}

// --- Suite 5: storeVerifiedFix ---

async function testStoreVerifiedFix() {
  suite('Suite 5: storeVerifiedFix');

  // storeVerifiedFix has cloudProvider parameter
  const svfMatch = retrieverSource.match(/async storeVerifiedFix\([^)]*cloudProvider[^)]*\)/);
  record(
    'storeVerifiedFix accepts cloudProvider parameter',
    svfMatch !== null,
    svfMatch === null
      ? 'cloudProvider parameter not found in storeVerifiedFix signature'
      : undefined
  );

  // storeVerifiedFix passes cloudProvider to storeInGlobalCache
  const svfBody = retrieverSource.substring(
    retrieverSource.indexOf('async storeVerifiedFix('),
    retrieverSource.indexOf('async reportFixFailure(')
  );
  record(
    'storeVerifiedFix threads cloudProvider to storeInGlobalCache',
    svfBody.includes('cloudProvider)') && svfBody.includes('storeInGlobalCache'),
    !(svfBody.includes('cloudProvider)') && svfBody.includes('storeInGlobalCache'))
      ? 'cloudProvider not passed to storeInGlobalCache in storeVerifiedFix'
      : undefined
  );

  // Log message in storeVerifiedFix includes cloud provider
  record(
    'storeVerifiedFix log includes cloud provider',
    svfBody.includes('provider: ${cloudProvider'),
    !svfBody.includes('provider: ${cloudProvider')
      ? 'Log message in storeVerifiedFix does not include cloudProvider'
      : undefined
  );
}

// --- Suite 6: routes-legacy.ts Wiring ---

async function testRoutesWiring() {
  suite('Suite 6: routes-legacy.ts Wiring');

  // getRemediation wrapper has cloudProvider parameter
  const wrapperMatch = routesSource.match(/async function getRemediation\([^)]*cloudProvider[^)]*\)/);
  record(
    'getRemediation wrapper accepts cloudProvider parameter',
    wrapperMatch !== null,
    wrapperMatch === null
      ? 'cloudProvider parameter not found in getRemediation signature'
      : undefined
  );

  // Wrapper passes cloudProvider to getFixForCheck
  const wrapperStart = routesSource.indexOf('async function getRemediation(');
  const wrapperEnd = routesSource.indexOf('\n// Helper function to find matching brace', wrapperStart);
  const wrapperBody = routesSource.substring(wrapperStart, wrapperEnd > -1 ? wrapperEnd : wrapperStart + 2500);
  record(
    'Wrapper passes cloudProvider to getFixForCheck',
    wrapperBody.includes('cloudProvider') && wrapperBody.includes('getFixForCheck'),
    !(wrapperBody.includes('cloudProvider') && wrapperBody.includes('getFixForCheck'))
      ? 'cloudProvider not passed to getFixForCheck in wrapper'
      : undefined
  );

  // Wrapper uses cloudProvider || 'azure' in the RAG-shape mapping
  record(
    'Wrapper uses cloudProvider || azure in RAG shape mapping',
    wrapperBody.includes("cloudProvider: cloudProvider || 'azure'"),
    !wrapperBody.includes("cloudProvider: cloudProvider || 'azure'")
      ? "RAG shape mapping does not use cloudProvider || 'azure'"
      : undefined
  );

  // All 3 getRemediation call sites include session.cloudProvider
  const getRemediationCalls = routesSource.match(/await getRemediation\([\s\S]*?\)/g) || [];
  const callsWithCloudProvider = getRemediationCalls.filter(c => c.includes("session.cloudProvider || 'azure'"));
  record(
    'All 3 getRemediation call sites thread session.cloudProvider',
    callsWithCloudProvider.length === 3,
    callsWithCloudProvider.length !== 3
      ? `Expected 3 getRemediation calls with session.cloudProvider, found ${callsWithCloudProvider.length}`
      : undefined
  );

  // storeVerifiedFix call includes cloudProvider
  const svfCallIdx = routesSource.indexOf('intelligentFixRetriever.storeVerifiedFix(');
  const svfCallBlock = routesSource.substring(svfCallIdx, svfCallIdx + 300);
  record(
    'storeVerifiedFix call threads session.cloudProvider',
    svfCallBlock.includes("session.cloudProvider || 'azure'"),
    !svfCallBlock.includes("session.cloudProvider || 'azure'")
      ? 'session.cloudProvider not passed to storeVerifiedFix'
      : undefined
  );
}

// --- Main ---

async function runValidation() {
  console.log('\n🧪 Phase 7: Thread Cloud Provider — Validation\n');
  console.log('='.repeat(70));

  await loadSources();

  await testTodoRemoval();
  await testGetFixForCheckSignature();
  await testTier2Threading();
  await testStoreInGlobalCache();
  await testStoreVerifiedFix();
  await testRoutesWiring();

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
    console.log('🎉 ALL TESTS PASSED! Phase 7 implementation is valid.');
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
