#!/usr/bin/env tsx
/**
 * Phase 2: API Endpoint Testing Script
 *
 * Tests all user fix preferences API endpoints
 */

import axios from 'axios';

const BASE_URL = 'http://localhost:9005';
let authToken: string | null = null;
let testUserId: string | null = null;
let testPreferenceId: string | null = null;

interface TestResult {
  endpoint: string;
  method: string;
  status: 'PASS' | 'FAIL';
  statusCode?: number;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

function logTest(result: TestResult) {
  const icon = result.status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} ${result.method} ${result.endpoint} (${result.duration}ms)`);
  if (result.error) {
    console.log(`   Error: ${result.error}`);
  }
  if (result.statusCode) {
    console.log(`   Status: ${result.statusCode}`);
  }
  results.push(result);
}

async function testEndpoint(
  method: string,
  endpoint: string,
  data?: any,
  expectedStatus: number = 200
): Promise<any> {
  const start = Date.now();
  try {
    const config: any = {
      method,
      url: `${BASE_URL}${endpoint}`,
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    };

    if (data && (method === 'POST' || method === 'PUT')) {
      config.data = data;
    }

    const response = await axios(config);
    const duration = Date.now() - start;

    if (response.status === expectedStatus) {
      logTest({ endpoint, method, status: 'PASS', statusCode: response.status, duration });
    } else {
      logTest({
        endpoint,
        method,
        status: 'FAIL',
        statusCode: response.status,
        error: `Expected ${expectedStatus}, got ${response.status}`,
        duration,
      });
    }

    return response.data;
  } catch (error: any) {
    const duration = Date.now() - start;
    const statusCode = error.response?.status;

    if (statusCode === expectedStatus) {
      // Expected error (like 404)
      logTest({ endpoint, method, status: 'PASS', statusCode, duration });
    } else {
      logTest({
        endpoint,
        method,
        status: 'FAIL',
        statusCode,
        error: error.message,
        duration,
      });
    }

    if (statusCode !== expectedStatus) {
      throw error;
    }
  }
}

async function runTests() {
  console.log('🧪 Phase 2: API Endpoint Testing\n');
  console.log('=' .repeat(70));
  console.log('\n');

  // ============================================================
  // 1. Authentication Setup
  // ============================================================
  console.log('🔐 Test Suite 1: Authentication Setup');
  console.log('-'.repeat(70));

  try {
    // Login to get auth token
    const loginData = await testEndpoint('POST', '/api/auth/login', {
      username: 'test_phase1_user',
      password: 'hashedpassword123',
    });

    authToken = loginData.token;
    testUserId = loginData.user.id;
    console.log(`   ℹ️  Authenticated as user: ${testUserId}\n`);
  } catch (error) {
    console.log('   ⚠️  Using existing session\n');
  }

  // ============================================================
  // 2. Create Preference
  // ============================================================
  console.log('📝 Test Suite 2: Create Preference');
  console.log('-'.repeat(70));

  const createData = await testEndpoint(
    'POST',
    '/api/users/me/fix-preferences',
    {
      checkId: 'CKV_AZURE_59',
      resourceType: 'azurerm_storage_account',
      fixSnippet: 'allow_nested_items_to_be_public = false',
      confidence: 0.95,
      source: 'user_verified',
      timesUsed: 0,
      successCount: 0,
      failureCount: 0,
    },
    201
  );

  testPreferenceId = createData.id;
  console.log(`   ℹ️  Created preference: ${testPreferenceId}\n`);

  // ============================================================
  // 3. Read Operations
  // ============================================================
  console.log('📖 Test Suite 3: Read Operations');
  console.log('-'.repeat(70));

  // Get all preferences
  await testEndpoint('GET', '/api/users/me/fix-preferences');

  // Get specific preference
  await testEndpoint(
    'GET',
    '/api/users/me/fix-preferences/CKV_AZURE_59/azurerm_storage_account'
  );

  // Get top fixes
  await testEndpoint('GET', '/api/users/me/fix-preferences/top?limit=5');

  // Get stats
  await testEndpoint('GET', '/api/users/me/fix-preferences/stats');

  console.log('');

  // ============================================================
  // 4. Update Operations
  // ============================================================
  console.log('✏️  Test Suite 4: Update Operations');
  console.log('-'.repeat(70));

  // Update preference
  await testEndpoint(
    'PUT',
    `/api/users/me/fix-preferences/${testPreferenceId}`,
    {
      confidence: 0.99,
      source: 'user_verified',
    }
  );

  // Increment usage (success)
  await testEndpoint(
    'POST',
    `/api/users/me/fix-preferences/${testPreferenceId}/use`,
    { success: true }
  );

  // Increment usage (failure)
  await testEndpoint(
    'POST',
    `/api/users/me/fix-preferences/${testPreferenceId}/use`,
    { success: false }
  );

  console.log('');

  // ============================================================
  // 5. Search Operations
  // ============================================================
  console.log('🔍 Test Suite 5: Search Operations');
  console.log('-'.repeat(70));

  // Search by check ID
  await testEndpoint('GET', '/api/users/me/fix-preferences/search?q=CKV_AZURE');

  // Get low confidence preferences
  await testEndpoint('GET', '/api/users/me/fix-preferences/low-confidence?threshold=0.5');

  console.log('');

  // ============================================================
  // 6. Public Endpoints (No Auth)
  // ============================================================
  console.log('🌐 Test Suite 6: Public Endpoints');
  console.log('-'.repeat(70));

  // Temporarily remove auth token
  const savedToken = authToken;
  authToken = null;

  // Get fixes for check (public)
  await testEndpoint(
    'GET',
    '/api/fix-preferences/check/CKV_AZURE_59/azurerm_storage_account'
  );

  // Restore auth token
  authToken = savedToken;

  console.log('');

  // ============================================================
  // 7. Create Additional Test Data
  // ============================================================
  console.log('📦 Test Suite 7: Additional Test Data');
  console.log('-'.repeat(70));

  // Create a few more preferences for testing
  await testEndpoint(
    'POST',
    '/api/users/me/fix-preferences',
    {
      checkId: 'CKV_AZURE_33',
      resourceType: 'azurerm_storage_queue',
      fixSnippet: 'enable_https_traffic_only = true',
      confidence: 0.85,
      source: 'checkov',
      timesUsed: 0,
      successCount: 0,
      failureCount: 0,
    },
    201
  );

  await testEndpoint(
    'POST',
    '/api/users/me/fix-preferences',
    {
      checkId: 'CKV_AZURE_206',
      resourceType: 'azurerm_storage_account',
      fixSnippet: 'account_replication_type = "ZRS"',
      confidence: 0.20, // Low confidence for cleanup testing
      source: 'ai_generated',
      timesUsed: 0,
      successCount: 0,
      failureCount: 0,
    },
    201
  );

  console.log('');

  // ============================================================
  // 8. Cleanup Operations
  // ============================================================
  console.log('🧹 Test Suite 8: Cleanup Operations');
  console.log('-'.repeat(70));

  // Get low confidence preferences
  const lowConfResult = await testEndpoint(
    'GET',
    '/api/users/me/fix-preferences/low-confidence?threshold=0.3'
  );
  console.log(`   ℹ️  Found ${lowConfResult.count} low confidence preference(s)`);

  // Cleanup low confidence
  const cleanupResult = await testEndpoint(
    'POST',
    '/api/users/me/fix-preferences/cleanup',
    { threshold: 0.3 }
  );
  console.log(`   ℹ️  Cleaned up ${cleanupResult.count} preference(s)`);

  console.log('');

  // ============================================================
  // 9. Delete Operations
  // ============================================================
  console.log('🗑️  Test Suite 9: Delete Operations');
  console.log('-'.repeat(70));

  // Delete specific preference
  await testEndpoint('DELETE', `/api/users/me/fix-preferences/${testPreferenceId}`);

  // Get all remaining preferences
  const remaining = await testEndpoint('GET', '/api/users/me/fix-preferences');
  console.log(`   ℹ️  Remaining preferences: ${remaining.count}`);

  // Delete all preferences
  const deleteAllResult = await testEndpoint('DELETE', '/api/users/me/fix-preferences');
  console.log(`   ℹ️  Deleted ${deleteAllResult.count} preference(s)`);

  console.log('');

  // ============================================================
  // 10. Error Handling
  // ============================================================
  console.log('⚠️  Test Suite 10: Error Handling');
  console.log('-'.repeat(70));

  // Try to get non-existent preference (should 404)
  await testEndpoint(
    'GET',
    '/api/users/me/fix-preferences/nonexistent-id',
    undefined,
    404
  );

  // Try to access without auth (should 401)
  const savedToken2 = authToken;
  authToken = null;
  await testEndpoint('GET', '/api/users/me/fix-preferences', undefined, 401);
  authToken = savedToken2;

  // Try invalid data (should 400)
  try {
    await testEndpoint(
      'POST',
      '/api/users/me/fix-preferences',
      {
        // Missing required fields
        checkId: 'TEST',
      },
      400
    );
  } catch {
    // Expected to fail
  }

  console.log('');

  // ============================================================
  // Final Report
  // ============================================================
  console.log('='.repeat(70));
  console.log('📊 TEST RESULTS');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;
  const successRate = ((passed / total) * 100).toFixed(1);

  console.log(`\n✅ Passed: ${passed}/${total} (${successRate}%)`);
  console.log(`❌ Failed: ${failed}/${total}`);

  if (failed > 0) {
    console.log('\n⚠️  Failed Tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`   - ${r.method} ${r.endpoint}: ${r.error}`);
    });
  }

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / total;
  console.log(`\n⏱️  Average response time: ${avgDuration.toFixed(1)}ms`);

  console.log('\n' + '='.repeat(70));

  if (passed === total) {
    console.log('🎉 ALL TESTS PASSED! Phase 2 API is working correctly.');
  } else {
    console.log('⚠️  Some tests failed. Review errors above.');
  }

  return passed === total;
}

// Run tests
runTests()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error('\n💥 Testing crashed:', error);
    process.exit(1);
  });
