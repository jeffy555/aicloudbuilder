#!/usr/bin/env tsx
/**
 * Phase 6: Validation Script
 *
 * Validates that IntelligentFixRetriever is correctly wired into the production
 * request path in routes-legacy.ts, gated behind the intelligentFixRetrieval flag.
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
let flagsSource = '';
let envContent = '';

async function loadSources(): Promise<void> {
  routesSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'routes-legacy.ts'), 'utf-8'
  );
  retrieverSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'intelligent-fix-retriever.ts'), 'utf-8'
  );
  flagsSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'middleware', 'feature-flags.ts'), 'utf-8'
  );
  envContent = await fs.readFile(
    path.join(PROJECT_ROOT, '.env'), 'utf-8'
  );
}

// --- Suite 1: Import Wiring ---

async function testImports() {
  suite('Suite 1: Import Wiring');

  // intelligentFixRetriever is imported
  record(
    'routes-legacy.ts imports intelligentFixRetriever',
    routesSource.includes('import { intelligentFixRetriever }') &&
    routesSource.includes('./rag/intelligent-fix-retriever'),
    !(routesSource.includes('import { intelligentFixRetriever }') &&
      routesSource.includes('./rag/intelligent-fix-retriever'))
      ? 'Import of intelligentFixRetriever not found'
      : undefined
  );

  // featureFlags is imported
  record(
    'routes-legacy.ts imports featureFlags',
    routesSource.includes('import { featureFlags }') &&
    routesSource.includes('./middleware/feature-flags'),
    !(routesSource.includes('import { featureFlags }') &&
      routesSource.includes('./middleware/feature-flags'))
      ? 'Import of featureFlags not found'
      : undefined
  );

  // intelligentFixRetriever singleton is exported from intelligent-fix-retriever.ts
  record(
    'intelligent-fix-retriever.ts exports singleton',
    retrieverSource.includes('export const intelligentFixRetriever = new IntelligentFixRetriever()'),
    !retrieverSource.includes('export const intelligentFixRetriever = new IntelligentFixRetriever()')
      ? 'Singleton export not found'
      : undefined
  );
}

// --- Suite 2: getRemediation Wrapper ---

async function testGetRemediationWrapper() {
  suite('Suite 2: getRemediation Wrapper Function');

  // Wrapper function exists
  record(
    'getRemediation wrapper function is defined',
    routesSource.includes('async function getRemediation('),
    !routesSource.includes('async function getRemediation(')
      ? 'getRemediation function not found'
      : undefined
  );

  // Wrapper checks intelligentFixRetrieval flag
  record(
    'Wrapper gates on featureFlags.intelligentFixRetrieval',
    routesSource.includes('featureFlags.intelligentFixRetrieval') &&
    routesSource.includes('intelligentFixRetriever.getFixForCheck('),
    !(routesSource.includes('featureFlags.intelligentFixRetrieval') &&
      routesSource.includes('intelligentFixRetriever.getFixForCheck('))
      ? 'Flag check or getFixForCheck call not found in wrapper'
      : undefined
  );

  // Wrapper accepts userId parameter
  record(
    'Wrapper accepts userId parameter',
    routesSource.includes('async function getRemediation(') &&
    routesSource.match(/async function getRemediation\([^)]*userId[^)]*\)/) !== null,
    routesSource.match(/async function getRemediation\([^)]*userId[^)]*\)/) === null
      ? 'userId parameter not found in getRemediation signature'
      : undefined
  );

  // Wrapper falls back to remediationRAGService.findRemediation when flag is off
  // Check that the fallback is inside getRemediation (after the if block)
  const wrapperStart = routesSource.indexOf('async function getRemediation(');
  const wrapperEnd = routesSource.indexOf('\n// Helper function to find matching brace', wrapperStart);
  const wrapperBody = routesSource.substring(wrapperStart, wrapperEnd > -1 ? wrapperEnd : wrapperStart + 2000);
  record(
    'Wrapper falls back to remediationRAGService.findRemediation when flag off',
    wrapperBody.includes('return remediationRAGService.findRemediation('),
    !wrapperBody.includes('return remediationRAGService.findRemediation(')
      ? 'Fallback to remediationRAGService.findRemediation not found in wrapper'
      : undefined
  );

  // Wrapper maps IntelligentFixResult to RAG-compatible shape (has snippet.fixSnippet)
  record(
    'Wrapper maps result to RAG-compatible shape with snippet.fixSnippet',
    wrapperBody.includes('fixSnippet: result.fix'),
    !wrapperBody.includes('fixSnippet: result.fix')
      ? 'RAG-compatible mapping (fixSnippet: result.fix) not found'
      : undefined
  );

  // Wrapper maps confidence
  record(
    'Wrapper maps confidence from IntelligentFixResult',
    wrapperBody.includes('confidence: result.confidence'),
    !wrapperBody.includes('confidence: result.confidence')
      ? 'Confidence mapping not found in wrapper'
      : undefined
  );
}

// --- Suite 3: Call Site Replacement ---

async function testCallSiteReplacement() {
  suite('Suite 3: Call Site Replacement');

  // No direct calls to remediationRAGService.findRemediation remain outside the wrapper
  // (only the wrapper + its JSDoc comment should reference it)
  const wrapperJsdocStart = routesSource.indexOf('/**\n * Phase 6: Unified remediation retrieval wrapper.');
  const wrapperStart = wrapperJsdocStart > -1 ? wrapperJsdocStart : routesSource.indexOf('async function getRemediation(');
  const wrapperEnd = routesSource.indexOf('\n// Helper function to find matching brace', wrapperStart);
  const outsideWrapper = routesSource.substring(0, wrapperStart) +
    routesSource.substring(wrapperEnd > -1 ? wrapperEnd : wrapperStart + 2000);

  const directCalls = (outsideWrapper.match(/remediationRAGService\.findRemediation\(/g) || []).length;
  record(
    'No direct remediationRAGService.findRemediation calls outside wrapper',
    directCalls === 0,
    directCalls > 0
      ? `Found ${directCalls} direct call(s) outside wrapper — expected 0`
      : undefined
  );

  // All 3 call sites now use getRemediation
  const getRemediationCalls = (routesSource.match(/await getRemediation\(/g) || []).length;
  record(
    'All 3 original call sites replaced with getRemediation()',
    getRemediationCalls === 3,
    getRemediationCalls !== 3
      ? `Expected 3 getRemediation() calls, found ${getRemediationCalls}`
      : undefined
  );

  // Each call site threads session.userId
  const userIdThreading = (routesSource.match(/getRemediation\([^)]*\n[^)]*\n[^)]*\n[^)]*\n[^)]*session\.userId/g) || []).length;
  record(
    'Call sites thread session.userId to getRemediation',
    userIdThreading === 3,
    userIdThreading !== 3
      ? `Expected 3 call sites threading session.userId, found ${userIdThreading}`
      : undefined
  );
}

// --- Suite 4: Verification Callback Wiring ---

async function testVerificationCallbacks() {
  suite('Suite 4: Verification Callbacks');

  // Success path calls storeVerifiedFix when flag is on
  record(
    'Success path calls intelligentFixRetriever.storeVerifiedFix',
    routesSource.includes('intelligentFixRetriever.storeVerifiedFix('),
    !routesSource.includes('intelligentFixRetriever.storeVerifiedFix(')
      ? 'storeVerifiedFix call not found'
      : undefined
  );

  // Failure path calls reportFixFailure when flag is on
  record(
    'Failure path calls intelligentFixRetriever.reportFixFailure',
    routesSource.includes('intelligentFixRetriever.reportFixFailure('),
    !routesSource.includes('intelligentFixRetriever.reportFixFailure(')
      ? 'reportFixFailure call not found'
      : undefined
  );

  // storeVerifiedFix is gated behind featureFlags.intelligentFixRetrieval
  // Find the storeVerifiedFix call and check it's inside a featureFlags.intelligentFixRetrieval block
  const storeIdx = routesSource.indexOf('intelligentFixRetriever.storeVerifiedFix(');
  const storeBlockStart = routesSource.lastIndexOf('featureFlags.intelligentFixRetrieval', storeIdx);
  const storeGated = storeIdx > -1 && storeBlockStart > -1 && (storeIdx - storeBlockStart) < 500;
  record(
    'storeVerifiedFix is gated behind intelligentFixRetrieval flag',
    storeGated,
    storeGated ? undefined
      : storeIdx === -1 ? 'storeVerifiedFix not found'
      : storeBlockStart === -1 ? 'No intelligentFixRetrieval gate found before storeVerifiedFix'
      : 'storeVerifiedFix too far from flag check — may not be gated'
  );

  // reportFixFailure is gated behind featureFlags.intelligentFixRetrieval
  const reportIdx = routesSource.indexOf('intelligentFixRetriever.reportFixFailure(');
  const reportBlockStart = routesSource.lastIndexOf('featureFlags.intelligentFixRetrieval', reportIdx);
  const reportGated = reportIdx > -1 && reportBlockStart > -1 && (reportIdx - reportBlockStart) < 300;
  record(
    'reportFixFailure is gated behind intelligentFixRetrieval flag',
    reportGated,
    reportGated ? undefined
      : reportIdx === -1 ? 'reportFixFailure not found'
      : reportBlockStart === -1 ? 'No intelligentFixRetrieval gate found before reportFixFailure'
      : 'reportFixFailure too far from flag check — may not be gated'
  );

  // Legacy path (updateFixFromVerification) preserved inside else branch
  // After the storeVerifiedFix block, there should be an else with the legacy path
  const legacyPassIdx = routesSource.indexOf('remediationRAGService.updateFixFromVerification(', storeIdx);
  record(
    'Legacy success path (updateFixFromVerification) preserved in else branch',
    legacyPassIdx > storeIdx,
    legacyPassIdx <= storeIdx
      ? 'Legacy updateFixFromVerification not found after intelligent path'
      : undefined
  );

  // Legacy failure path preserved
  const legacyFailIdx = routesSource.indexOf('remediationRAGService.updateFixFromVerification(', reportIdx);
  record(
    'Legacy failure path (updateFixFromVerification false) preserved in else branch',
    legacyFailIdx > reportIdx,
    legacyFailIdx <= reportIdx
      ? 'Legacy failure updateFixFromVerification not found after reportFixFailure'
      : undefined
  );

  // storeVerifiedFix threads session.userId
  const storeBlock = routesSource.substring(storeIdx, storeIdx + 400);
  record(
    'storeVerifiedFix threads session.userId',
    storeBlock.includes('session.userId'),
    !storeBlock.includes('session.userId')
      ? 'session.userId not threaded to storeVerifiedFix'
      : undefined
  );

  // reportFixFailure threads session.userId
  const reportBlock = routesSource.substring(reportIdx, reportIdx + 300);
  record(
    'reportFixFailure threads session.userId',
    reportBlock.includes('session.userId'),
    !reportBlock.includes('session.userId')
      ? 'session.userId not threaded to reportFixFailure'
      : undefined
  );
}

// --- Suite 5: Feature Flag & Zero-Change Guarantee ---

async function testFeatureFlagAndZeroChange() {
  suite('Suite 5: Feature Flag & Zero-Change Guarantee');

  // Feature flag env var exists in feature-flags.ts
  record(
    'intelligentFixRetrieval flag reads ENABLE_INTELLIGENT_FIX_RETRIEVAL',
    flagsSource.includes("ENABLE_INTELLIGENT_FIX_RETRIEVAL === 'true'"),
    !flagsSource.includes("ENABLE_INTELLIGENT_FIX_RETRIEVAL === 'true'")
      ? 'Env var read not found in feature-flags.ts'
      : undefined
  );

  // .env has ENABLE_INTELLIGENT_FIX_RETRIEVAL (default false)
  record(
    '.env has ENABLE_INTELLIGENT_FIX_RETRIEVAL=false',
    envContent.includes('ENABLE_INTELLIGENT_FIX_RETRIEVAL=false'),
    !envContent.includes('ENABLE_INTELLIGENT_FIX_RETRIEVAL=false')
      ? 'ENABLE_INTELLIGENT_FIX_RETRIEVAL not found or not set to false in .env'
      : undefined
  );

  // IntelligentFixResult interface is exported
  record(
    'IntelligentFixResult interface is exported from intelligent-fix-retriever.ts',
    retrieverSource.includes('export interface IntelligentFixResult'),
    !retrieverSource.includes('export interface IntelligentFixResult')
      ? 'IntelligentFixResult interface not exported'
      : undefined
  );

  // getFixForCheck method exists with correct signature (5 params + optional context)
  record(
    'getFixForCheck accepts checkId, resourceType, checkName, guideline, userId',
    retrieverSource.includes('async getFixForCheck(') &&
    retrieverSource.includes('checkId: string') &&
    retrieverSource.includes('resourceType: string') &&
    retrieverSource.includes('checkName: string') &&
    retrieverSource.includes('guideline: string') &&
    retrieverSource.includes('userId?: string'),
    !(retrieverSource.includes('async getFixForCheck(') &&
      retrieverSource.includes('userId?: string'))
      ? 'getFixForCheck signature incomplete'
      : undefined
  );

  // storeVerifiedFix method exists
  record(
    'storeVerifiedFix method exists in IntelligentFixRetriever',
    retrieverSource.includes('async storeVerifiedFix('),
    !retrieverSource.includes('async storeVerifiedFix(')
      ? 'storeVerifiedFix method not found'
      : undefined
  );

  // reportFixFailure method exists
  record(
    'reportFixFailure method exists in IntelligentFixRetriever',
    retrieverSource.includes('async reportFixFailure('),
    !retrieverSource.includes('async reportFixFailure(')
      ? 'reportFixFailure method not found'
      : undefined
  );
}

// --- Main ---

async function runValidation() {
  console.log('\n🧪 Phase 6: Wire IntelligentFixRetriever into Request Path — Validation\n');
  console.log('='.repeat(70));

  await loadSources();

  await testImports();
  await testGetRemediationWrapper();
  await testCallSiteReplacement();
  await testVerificationCallbacks();
  await testFeatureFlagAndZeroChange();

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
    console.log('🎉 ALL TESTS PASSED! Phase 6 implementation is valid.');
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
