#!/usr/bin/env tsx
/**
 * Phase 5: Validation Script
 *
 * Validates the Gradual Template Deprecation implementation.
 * Tests file structure, getVerifiedCount behaviour, threshold gate logic,
 * and env var wiring.
 * Does NOT require a running server or database.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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

let ragSource = '';
let storeSource = '';
let envContent = '';

async function loadSources(): Promise<void> {
  ragSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'remediation-rag.ts'), 'utf-8'
  );
  storeSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'fix-snippet-store.ts'), 'utf-8'
  );
  envContent = await fs.readFile(
    path.join(PROJECT_ROOT, '.env'), 'utf-8'
  );
}

// --- Suite 1: File Structure & Env Var ---

async function testFileStructure() {
  suite('Suite 1: File Structure & Env Var');

  // remediation-rag.ts exists
  record(
    'remediation-rag.ts exists',
    ragSource.length > 0
  );

  // fix-snippet-store.ts exists
  record(
    'fix-snippet-store.ts exists',
    storeSource.length > 0
  );

  // .env has TEMPLATE_DEPRECATION_THRESHOLD
  record(
    '.env has TEMPLATE_DEPRECATION_THRESHOLD',
    envContent.includes('TEMPLATE_DEPRECATION_THRESHOLD'),
    envContent.includes('TEMPLATE_DEPRECATION_THRESHOLD') ? undefined : 'Env var not found'
  );

  // .env default value is 50
  record(
    '.env default threshold is 50',
    envContent.includes('TEMPLATE_DEPRECATION_THRESHOLD=50'),
    envContent.includes('TEMPLATE_DEPRECATION_THRESHOLD=50') ? undefined : 'Expected default value of 50'
  );
}

// --- Suite 2: getVerifiedCount Method ---

async function testGetVerifiedCount() {
  suite('Suite 2: getVerifiedCount Method');

  // Method exists in source
  record(
    'fix-snippet-store.ts exports getVerifiedCount()',
    storeSource.includes('getVerifiedCount()')
  );

  // Method filters on verified AND not deprecated
  record(
    'getVerifiedCount filters on verified && !deprecated',
    storeSource.includes('s.verified && !s.deprecated'),
    storeSource.includes('s.verified && !s.deprecated') ? undefined : 'Filter condition not found'
  );

  // Import and run against an empty store instance
  const { FixSnippetStore } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'server', 'rag', 'fix-snippet-store.ts')).href
  );

  // Use a temp path so we don't touch production cache
  const testStore = new FixSnippetStore('.cache/phase5-test-snippets.json');
  await testStore.loadFromDisk();

  // Empty store returns 0
  const emptyCount = testStore.getVerifiedCount();
  record(
    'getVerifiedCount returns 0 on empty store',
    emptyCount === 0,
    emptyCount !== 0 ? `Expected 0, got ${emptyCount}` : undefined
  );

  // Store a non-verified snippet → count stays 0
  await testStore.store({
    checkId: 'CKV_TEST_1',
    resourceType: 'azurerm_test_resource',
    cloudProvider: 'azure',
    fixSnippet: 'test_attr = true',
    context: 'test',
    guideline: 'test',
    source: 'generated',
    confidence: 0.8,
    successCount: 1,
    failureCount: 0,
    verified: false,
    deprecated: false,
    lastUsed: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const afterUnverified = testStore.getVerifiedCount();
  record(
    'Non-verified snippet does not increment count',
    afterUnverified === 0,
    afterUnverified !== 0 ? `Expected 0, got ${afterUnverified}` : undefined
  );

  // Store a verified snippet → count becomes 1
  await testStore.store({
    checkId: 'CKV_TEST_2',
    resourceType: 'azurerm_test_resource',
    cloudProvider: 'azure',
    fixSnippet: 'verified_attr = true',
    context: 'test verified',
    guideline: 'test',
    source: 'retrieved',
    confidence: 0.9,
    successCount: 5,
    failureCount: 0,
    verified: true,
    deprecated: false,
    lastUsed: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const afterVerified = testStore.getVerifiedCount();
  record(
    'Verified snippet increments count to 1',
    afterVerified === 1,
    afterVerified !== 1 ? `Expected 1, got ${afterVerified}` : undefined
  );

  // Store a verified BUT deprecated snippet → count stays 1
  await testStore.store({
    checkId: 'CKV_TEST_3',
    resourceType: 'azurerm_test_resource',
    cloudProvider: 'azure',
    fixSnippet: 'deprecated_attr = false',
    context: 'test deprecated',
    guideline: 'test',
    source: 'retrieved',
    confidence: 0.4,
    successCount: 1,
    failureCount: 5,
    verified: true,
    deprecated: true,
    lastUsed: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const afterDeprecated = testStore.getVerifiedCount();
  record(
    'Deprecated snippet excluded from verified count',
    afterDeprecated === 1,
    afterDeprecated !== 1 ? `Expected 1, got ${afterDeprecated}` : undefined
  );

  // Clean up test cache file
  try {
    const testPath = path.join(process.cwd(), '.cache', 'phase5-test-snippets.json');
    await fs.unlink(testPath);
  } catch { /* file may not exist */ }
}

// --- Suite 3: Threshold Gate in initialize() ---

async function testThresholdGate() {
  suite('Suite 3: Threshold Gate in initialize()');

  // Reads TEMPLATE_DEPRECATION_THRESHOLD from env with default 50
  record(
    'Reads TEMPLATE_DEPRECATION_THRESHOLD with default 50',
    ragSource.includes("process.env.TEMPLATE_DEPRECATION_THRESHOLD || '50'"),
    ragSource.includes("process.env.TEMPLATE_DEPRECATION_THRESHOLD || '50'") ? undefined : 'Env var read with default not found'
  );

  // Calls getVerifiedCount() to get current count
  record(
    'Calls fixSnippetStore.getVerifiedCount()',
    ragSource.includes('fixSnippetStore.getVerifiedCount()')
  );

  // Gate condition: verifiedCount >= deprecationThreshold
  record(
    'Gate condition compares verifiedCount >= deprecationThreshold',
    ragSource.includes('verifiedCount >= deprecationThreshold')
  );

  // When gate triggers: logs deprecation message, does NOT load templates
  record(
    'Logs deprecation message when threshold reached',
    ragSource.includes('Templates deprecated:') && ragSource.includes('Skipping template load')
  );

  // When gate does NOT trigger: loads templates via loadTemplatesFromDirectory()
  record(
    'Loads templates when below threshold',
    ragSource.includes('loadTemplatesFromDirectory()') &&
    ragSource.includes('verified snippets < threshold')
  );

  // Template indexing is already conditional on this.templates.length > 0
  // (it was conditional before Phase 5 — verify it's still there)
  record(
    'Template indexing remains conditional on templates.length > 0',
    ragSource.includes('if (this.templates.length > 0)') &&
    ragSource.includes('await this.indexTemplates()')
  );

  // Gate runs AFTER fixSnippetStore.loadFromDisk() (snippets must be loaded first)
  const loadDiskIdx = ragSource.indexOf('fixSnippetStore.loadFromDisk()');
  const gateIdx = ragSource.indexOf('getVerifiedCount()');
  record(
    'Threshold gate runs after snippets are loaded from disk',
    loadDiskIdx > -1 && gateIdx > -1 && gateIdx > loadDiskIdx,
    loadDiskIdx === -1 ? 'loadFromDisk() not found'
      : gateIdx === -1 ? 'getVerifiedCount() not found'
      : gateIdx > loadDiskIdx ? undefined
      : 'getVerifiedCount() appears before loadFromDisk()'
  );
}

// --- Suite 4: Tier 3 Natural No-op ---

async function testTier3NoOp() {
  suite('Suite 4: Tier 3 Natural No-op');

  // Tier 3 template fallback searches this.templates
  record(
    'Tier 3 searches this.templates array',
    ragSource.includes('this.templates.find(t => t.check_id === checkId)')
  );

  // this.templates is initialised as empty array (class field)
  record(
    'this.templates initialised as empty array',
    ragSource.includes('private templates: RemediationTemplate[] = []')
  );

  // No explicit "templates deprecated" check in Tier 3 — it just finds nothing
  // Verify there is no featureFlag or threshold check inside the Tier 3 block
  const tier3Block = ragSource.match(/Tier 3: Template fallback[\s\S]*?(?=\/\/ Tier 4)/);
  const tier3HasNoGate = tier3Block && !tier3Block[0].includes('deprecationThreshold') && !tier3Block[0].includes('featureFlags');
  record(
    'Tier 3 has no extra gate — naturally returns nothing when templates empty',
    !!tier3HasNoGate,
    !tier3Block ? 'Tier 3 block not found'
      : tier3HasNoGate ? undefined
      : 'Unexpected gate logic in Tier 3'
  );
}

// --- Main ---

async function runValidation() {
  console.log('\n🧪 Phase 5: Gradual Template Deprecation — Validation\n');
  console.log('='.repeat(70));

  await loadSources();

  await testFileStructure();
  await testGetVerifiedCount();
  await testThresholdGate();
  await testTier3NoOp();

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
    console.log('🎉 ALL TESTS PASSED! Phase 5 implementation is valid.');
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
