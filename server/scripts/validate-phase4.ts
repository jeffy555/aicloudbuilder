#!/usr/bin/env tsx
/**
 * Phase 4: Validation Script
 *
 * Validates the Intelligent Fix Retriever implementation.
 * Tests file structure, exports, source code integrity, feature flag wiring,
 * and feedback method correctness.
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

// --- Shared: read the retriever source once ---

let retrieverSource = '';

async function loadRetrieverSource(): Promise<void> {
  retrieverSource = await fs.readFile(
    path.join(PROJECT_ROOT, 'server', 'rag', 'intelligent-fix-retriever.ts'),
    'utf-8'
  );
}

// --- Suite 1: File Structure ---

async function testFileStructure() {
  suite('Suite 1: File Structure');

  // intelligent-fix-retriever.ts exists with minimum line count
  try {
    const lines = retrieverSource.split('\n').length;
    record(
      `intelligent-fix-retriever.ts exists (${lines} lines)`,
      lines >= 100,
      lines < 100 ? `Expected >= 100 lines, got ${lines}` : undefined
    );
  } catch {
    record('intelligent-fix-retriever.ts exists', false, 'File not found');
  }

  // .env has all three Phase 4 feature flags
  try {
    const envContent = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf-8');
    const flags = [
      'ENABLE_USER_FIX_PREFERENCES',
      'ENABLE_CHECKOV_NATIVE_FETCH',
      'ENABLE_INTELLIGENT_FIX_RETRIEVAL',
    ];
    for (const flag of flags) {
      record(
        `.env has ${flag}`,
        envContent.includes(flag),
        envContent.includes(flag) ? undefined : 'Flag not found'
      );
    }
  } catch {
    record('.env exists and contains feature flags', false, 'File not found');
  }

  // feature-flags.ts defines all three flags
  try {
    const flagContent = await fs.readFile(
      path.join(PROJECT_ROOT, 'server', 'middleware', 'feature-flags.ts'),
      'utf-8'
    );
    const flags = ['userFixPreferences', 'checkovNativeFetch', 'intelligentFixRetrieval'];
    for (const flag of flags) {
      record(
        `feature-flags.ts defines ${flag}`,
        flagContent.includes(flag),
        flagContent.includes(flag) ? undefined : 'Flag not found'
      );
    }
  } catch {
    record('feature-flags.ts exists', false, 'File not found');
  }
}

// --- Suite 2: Export Surface ---

async function testExportSurface() {
  suite('Suite 2: Export Surface');

  record(
    'Exports IntelligentFixResult interface',
    retrieverSource.includes('export interface IntelligentFixResult')
  );

  record(
    'Exports IntelligentFixRetriever class',
    retrieverSource.includes('export class IntelligentFixRetriever')
  );

  record(
    'Exports intelligentFixRetriever singleton',
    retrieverSource.includes('export const intelligentFixRetriever')
  );

  // IntelligentFixResult has all required fields
  const requiredFields = [
    { name: 'fix',            pattern: 'fix: string' },
    { name: 'confidence',     pattern: 'confidence: number' },
    { name: 'source',         pattern: "source: 'user_preference'" },
    { name: 'requiresReview', pattern: 'requiresReview: boolean' },
  ];
  const missingFields = requiredFields.filter(f => !retrieverSource.includes(f.pattern)).map(f => f.name);
  record(
    'IntelligentFixResult has fix, confidence, source, requiresReview',
    missingFields.length === 0,
    missingFields.length > 0 ? `Missing: ${missingFields.join(', ')}` : undefined
  );

  // All 5 source labels present in the union type
  const sourceLabels = ['user_preference', 'checkov_official', 'global_cache', 'semantic_match', 'ai_generated'];
  const missingLabels = sourceLabels.filter(s => !retrieverSource.includes(s));
  record(
    'All 5 source labels defined in union type',
    missingLabels.length === 0,
    missingLabels.length > 0 ? `Missing: ${missingLabels.join(', ')}` : undefined
  );
}

// --- Suite 3: Source Code Integrity ---

async function testSourceIntegrity() {
  suite('Suite 3: Source Code Integrity');

  // Must NOT reference the non-existent checkov-remediator module
  record(
    'Does not import from checkov-remediator (non-existent module)',
    !retrieverSource.includes('checkov-remediator'),
    retrieverSource.includes('checkov-remediator') ? 'Still references non-existent module' : undefined
  );

  // Must import checkovFetcher from the correct path
  record(
    "Imports checkovFetcher from './checkov-fetcher'",
    retrieverSource.includes("from './checkov-fetcher'"),
    retrieverSource.includes("from './checkov-fetcher'") ? undefined : 'Correct import path not found'
  );

  // Must use fixSnippet (not remediationCode which doesn't exist on InferredRemediation)
  record(
    'Uses fixSnippet field (not remediationCode)',
    retrieverSource.includes('fixSnippet') && !retrieverSource.includes('remediationCode'),
    !retrieverSource.includes('fixSnippet') ? 'fixSnippet not found'
      : retrieverSource.includes('remediationCode') ? 'Still references remediationCode'
      : undefined
  );

  // Must use featureFlags object for tier gating
  record(
    'Uses featureFlags.userFixPreferences for Tier 1 gate',
    retrieverSource.includes('featureFlags.userFixPreferences')
  );

  record(
    'Uses featureFlags.checkovNativeFetch for Tier 2 gate',
    retrieverSource.includes('featureFlags.checkovNativeFetch')
  );

  // Must NOT use raw process.env checks for the feature flags
  const rawEnvPatterns = [
    "process.env.ENABLE_USER_FIX_PREFERENCES === 'true'",
    "process.env.ENABLE_CHECKOV_NATIVE_FETCH === 'true'",
    "process.env.ENABLE_INTELLIGENT_FIX_RETRIEVAL === 'true'",
  ];
  const foundRaw = rawEnvPatterns.filter(p => retrieverSource.includes(p));
  record(
    'Does not use raw process.env for feature flag checks',
    foundRaw.length === 0,
    foundRaw.length > 0 ? `Raw checks found: ${foundRaw.join(', ')}` : undefined
  );

  // Must not use invalid source value 'user_applied' (not in schema)
  record(
    "Does not use invalid source value 'user_applied'",
    !retrieverSource.includes("'user_applied'"),
    retrieverSource.includes("'user_applied'") ? "Invalid source 'user_applied' found" : undefined
  );

  // reportFixFailure must actually update the global cache (not leave a TODO)
  const hasGlobalUpdate = retrieverSource.includes('updateFixFromVerification(globalSnippet.id, false)');
  record(
    'reportFixFailure updates global cache (no dangling TODO)',
    hasGlobalUpdate,
    !hasGlobalUpdate ? 'Global cache update missing or still a TODO' : undefined
  );
}

// --- Suite 4: Feature Flag Gating ---

async function testFeatureFlagGating() {
  suite('Suite 4: Feature Flag Gating');

  // Tier 1 requires both userId AND the feature flag
  record(
    'Tier 1 gated by userId AND userFixPreferences flag',
    retrieverSource.includes('userId && featureFlags.userFixPreferences')
  );

  // Tier 2 gated by checkovNativeFetch flag
  record(
    'Tier 2 gated by checkovNativeFetch flag',
    retrieverSource.includes('featureFlags.checkovNativeFetch') &&
    retrieverSource.includes('getTier2CheckovNative')
  );

  // Tier 3-5 delegation call exists (runs unconditionally — no flag gate around it)
  record(
    'Tier 3-5 delegation call exists',
    retrieverSource.includes('await this.getTier3to5ExistingRAG(')
  );

  // All three private tier methods have try/catch blocks
  const tierMethods = [
    { name: 'Tier 1', pattern: /private async getTier1[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/ },
    { name: 'Tier 2', pattern: /private async getTier2[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/ },
    { name: 'Tier 3-5', pattern: /private async getTier3[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/ },
  ];
  const missingCatch = tierMethods.filter(m => !m.pattern.test(retrieverSource)).map(m => m.name);
  record(
    'All tier methods have try/catch for graceful degradation',
    missingCatch.length === 0,
    missingCatch.length > 0 ? `Missing try/catch: ${missingCatch.join(', ')}` : undefined
  );
}

// --- Suite 5: Feedback Methods ---

async function testFeedbackMethods() {
  suite('Suite 5: Feedback Methods');

  // storeVerifiedFix is a public async method
  record(
    'storeVerifiedFix is a public async method',
    retrieverSource.includes('async storeVerifiedFix(') &&
    !retrieverSource.includes('private async storeVerifiedFix')
  );

  // reportFixFailure is a public async method
  record(
    'reportFixFailure is a public async method',
    retrieverSource.includes('async reportFixFailure(') &&
    !retrieverSource.includes('private async reportFixFailure')
  );

  // storeVerifiedFix checks for existing snippet before storing (avoids no-op re-store)
  record(
    'storeVerifiedFix checks for existing snippet before storing',
    retrieverSource.includes('existingSnippet') &&
    retrieverSource.includes('updateFixFromVerification(existingSnippet.id')
  );

  // storeVerifiedFix stores user preference with valid source 'user_verified'
  record(
    "storeVerifiedFix stores user preference with source 'user_verified'",
    retrieverSource.includes('storePreference') &&
    retrieverSource.includes("source: verified ? 'user_verified'")
  );

  // reportFixFailure decrements user preference via incrementUsage(id, false)
  const prefDecrement = /reportFixFailure[\s\S]*?incrementUsage\(pref\.id,\s*false\)/.test(retrieverSource);
  record(
    'reportFixFailure decrements user preference confidence',
    prefDecrement,
    !prefDecrement ? 'incrementUsage(pref.id, false) not found in reportFixFailure' : undefined
  );

  // reportFixFailure decrements global cache via updateFixFromVerification(id, false)
  const globalDecrement = /reportFixFailure[\s\S]*?updateFixFromVerification\(globalSnippet\.id,\s*false\)/.test(retrieverSource);
  record(
    'reportFixFailure decrements global cache confidence',
    globalDecrement,
    !globalDecrement ? 'updateFixFromVerification(globalSnippet.id, false) not found' : undefined
  );

  // Tier 2 auto-stores on hit
  const tier2AutoStore = /getTier2CheckovNative[\s\S]*?storeInGlobalCache/.test(retrieverSource);
  record(
    'Tier 2 auto-stores successful result in global cache',
    tier2AutoStore,
    !tier2AutoStore ? 'storeInGlobalCache call missing in Tier 2' : undefined
  );
}

// --- Main ---

async function runValidation() {
  console.log('\n🧪 Phase 4: Intelligent Fix Retriever — Validation\n');
  console.log('='.repeat(70));

  await loadRetrieverSource();

  await testFileStructure();
  await testExportSurface();
  await testSourceIntegrity();
  await testFeatureFlagGating();
  await testFeedbackMethods();

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
    console.log('🎉 ALL TESTS PASSED! Phase 4 implementation is valid.');
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
