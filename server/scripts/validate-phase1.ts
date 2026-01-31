#!/usr/bin/env tsx
/**
 * Phase 1: Comprehensive Validation Suite
 *
 * Tests all aspects of the user_fix_preferences implementation
 */

import 'dotenv/config';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { userFixPreferences, users } from '../../shared/schema';
import { eq, and, desc } from 'drizzle-orm';

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

function startTest(name: string): number {
  return Date.now();
}

function endTest(name: string, startTime: number, passed: boolean, error?: string, details?: string) {
  const duration = Date.now() - startTime;
  results.push({ name, passed, duration, error, details });

  if (passed) {
    console.log(`   ✅ ${name} (${duration}ms)`);
    if (details) console.log(`      ${details}`);
  } else {
    console.log(`   ❌ ${name} (${duration}ms)`);
    if (error) console.log(`      Error: ${error}`);
  }
}

async function validatePhase1() {
  console.log('🔍 Phase 1: Comprehensive Validation Suite\n');
  console.log('=' .repeat(70));
  console.log('\n');

  // ============================================================
  // TEST SUITE 1: Database Structure
  // ============================================================
  console.log('📦 TEST SUITE 1: Database Structure');
  console.log('-'.repeat(70));

  // Test 1.1: Table Exists
  let start = startTest('Table Existence');
  try {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'user_fix_preferences'
      );
    `);
    const exists = result.rows[0]?.exists;
    endTest('Table Existence', start, exists === true, undefined, 'Table found in database');
  } catch (error: any) {
    endTest('Table Existence', start, false, error.message);
  }

  // Test 1.2: Column Count
  start = startTest('Column Count');
  try {
    const result = await db.execute(sql`
      SELECT COUNT(*) as count FROM information_schema.columns
      WHERE table_name = 'user_fix_preferences';
    `);
    const count = parseInt(result.rows[0]?.count);
    endTest('Column Count', start, count === 13, undefined, `Found ${count}/13 columns`);
  } catch (error: any) {
    endTest('Column Count', start, false, error.message);
  }

  // Test 1.3: Primary Key
  start = startTest('Primary Key Constraint');
  try {
    const result = await db.execute(sql`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'user_fix_preferences' AND constraint_type = 'PRIMARY KEY';
    `);
    endTest('Primary Key Constraint', start, result.rows.length === 1, undefined,
      `Constraint: ${result.rows[0]?.constraint_name}`);
  } catch (error: any) {
    endTest('Primary Key Constraint', start, false, error.message);
  }

  // Test 1.4: Foreign Key
  start = startTest('Foreign Key Constraint');
  try {
    const result = await db.execute(sql`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conrelid = 'user_fix_preferences'::regclass AND contype = 'f';
    `);
    const hasCascade = result.rows.some((r: any) => r.confdeltype === 'c');
    endTest('Foreign Key Constraint', start, result.rows.length === 1 && hasCascade, undefined,
      `ON DELETE CASCADE: ${hasCascade ? 'Yes' : 'No'}`);
  } catch (error: any) {
    endTest('Foreign Key Constraint', start, false, error.message);
  }

  // Test 1.5: Indexes
  start = startTest('Performance Indexes');
  try {
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'user_fix_preferences' AND schemaname = 'public';
    `);
    const expectedIndexes = ['user_fix_preferences_pkey', 'idx_user_fix_lookup', 'idx_check_lookup', 'idx_user_times_used'];
    const found = expectedIndexes.filter(name =>
      result.rows.some((r: any) => r.indexname === name)
    );
    endTest('Performance Indexes', start, found.length === 4, undefined,
      `Found ${found.length}/4 indexes`);
  } catch (error: any) {
    endTest('Performance Indexes', start, false, error.message);
  }

  console.log('');

  // ============================================================
  // TEST SUITE 2: Data Validation
  // ============================================================
  console.log('✏️  TEST SUITE 2: Data Validation');
  console.log('-'.repeat(70));

  // Get or create test user
  let testUserId: string | null = null;
  try {
    const existingUser = await db.execute(sql`SELECT id FROM users LIMIT 1;`);
    if (existingUser.rows.length > 0) {
      testUserId = existingUser.rows[0].id;
      console.log(`   ℹ️  Using existing user: ${testUserId}`);
    } else {
      console.log(`   ⚠️  No users found - creating test user`);
      const newUser = await db.execute(sql`
        INSERT INTO users (username, email, password)
        VALUES ('test_phase1_user', 'test@phase1.com', 'hashedpassword123')
        ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email
        RETURNING id;
      `);
      testUserId = newUser.rows[0].id;
      console.log(`   ✅ Created test user: ${testUserId}`);
    }
  } catch (error: any) {
    console.log(`   ❌ User setup failed: ${error.message}`);
  }

  if (testUserId) {
    // Test 2.1: Valid Insert
    start = startTest('Valid Data Insert');
    try {
      await db.insert(userFixPreferences).values({
        userId: testUserId,
        checkId: 'CKV_AZURE_TEST_001',
        resourceType: 'test_resource_type',
        fixSnippet: 'test_fix = true',
        confidence: 0.95,
        source: 'user_verified',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      });
      endTest('Valid Data Insert', start, true, undefined, 'Record inserted successfully');
    } catch (error: any) {
      endTest('Valid Data Insert', start, false, error.message);
    }

    // Test 2.2: Confidence Bounds (0.0 - 1.0)
    start = startTest('Confidence Validation (0.0-1.0)');
    try {
      // Valid: 0.0
      await db.insert(userFixPreferences).values({
        userId: testUserId,
        checkId: 'CKV_TEST_CONF_MIN',
        resourceType: 'test_resource',
        fixSnippet: 'test = true',
        confidence: 0.0,
        source: 'ai_generated',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      });

      // Valid: 1.0
      await db.insert(userFixPreferences).values({
        userId: testUserId,
        checkId: 'CKV_TEST_CONF_MAX',
        resourceType: 'test_resource',
        fixSnippet: 'test = true',
        confidence: 1.0,
        source: 'user_verified',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      });

      endTest('Confidence Validation (0.0-1.0)', start, true, undefined,
        'Accepted 0.0 and 1.0');
    } catch (error: any) {
      endTest('Confidence Validation (0.0-1.0)', start, false, error.message);
    }

    // Test 2.3: Required Fields
    start = startTest('Required Fields Enforcement');
    try {
      let failed = false;
      try {
        await db.execute(sql`
          INSERT INTO user_fix_preferences (user_id, check_id)
          VALUES (${testUserId}, 'TEST');
        `);
      } catch {
        failed = true; // Should fail - missing required fields
      }
      endTest('Required Fields Enforcement', start, failed, undefined,
        'Correctly rejected incomplete record');
    } catch (error: any) {
      endTest('Required Fields Enforcement', start, false, error.message);
    }

    // Test 2.4: Default Values
    start = startTest('Default Values');
    try {
      const result = await db.execute(sql`
        INSERT INTO user_fix_preferences (
          user_id, check_id, resource_type, fix_snippet, source
        ) VALUES (
          ${testUserId}, 'CKV_TEST_DEFAULTS', 'test_resource',
          'test = true', 'user_preference'
        ) RETURNING confidence, times_used, success_count, failure_count;
      `);

      const row = result.rows[0];
      const passed = row.confidence === 1 &&
                    row.times_used === 0 &&
                    row.success_count === 0 &&
                    row.failure_count === 0;

      endTest('Default Values', start, passed, undefined,
        `confidence=${row.confidence}, times_used=${row.times_used}`);
    } catch (error: any) {
      endTest('Default Values', start, false, error.message);
    }
  }

  console.log('');

  // ============================================================
  // TEST SUITE 3: Query Performance
  // ============================================================
  console.log('⚡ TEST SUITE 3: Query Performance');
  console.log('-'.repeat(70));

  if (testUserId) {
    // Test 3.1: Index Usage - User Fix Lookup
    start = startTest('Index: User Fix Lookup');
    try {
      const explain = await db.execute(sql`
        EXPLAIN (FORMAT JSON) SELECT * FROM user_fix_preferences
        WHERE user_id = ${testUserId}
        AND check_id = 'CKV_AZURE_TEST_001'
        AND resource_type = 'test_resource_type';
      `);

      const plan = JSON.stringify(explain.rows[0]);
      const usesIndex = plan.includes('idx_user_fix_lookup') || plan.includes('Index');

      endTest('Index: User Fix Lookup', start, usesIndex, undefined,
        usesIndex ? 'Using index for lookup' : 'Sequential scan (create index!)');
    } catch (error: any) {
      endTest('Index: User Fix Lookup', start, false, error.message);
    }

    // Test 3.2: Query Speed
    start = startTest('Query Speed (<10ms)');
    try {
      const queryStart = Date.now();
      await db.select()
        .from(userFixPreferences)
        .where(
          and(
            eq(userFixPreferences.userId, testUserId),
            eq(userFixPreferences.checkId, 'CKV_AZURE_TEST_001'),
            eq(userFixPreferences.resourceType, 'test_resource_type')
          )
        );
      const queryTime = Date.now() - queryStart;

      endTest('Query Speed (<10ms)', start, queryTime < 10, undefined,
        `Query completed in ${queryTime}ms`);
    } catch (error: any) {
      endTest('Query Speed (<10ms)', start, false, error.message);
    }

    // Test 3.3: ORDER BY Performance
    start = startTest('ORDER BY times_used Performance');
    try {
      const queryStart = Date.now();
      await db.select()
        .from(userFixPreferences)
        .where(eq(userFixPreferences.userId, testUserId))
        .orderBy(desc(userFixPreferences.timesUsed))
        .limit(10);
      const queryTime = Date.now() - queryStart;

      endTest('ORDER BY times_used Performance', start, queryTime < 15, undefined,
        `Sorted query in ${queryTime}ms`);
    } catch (error: any) {
      endTest('ORDER BY times_used Performance', start, false, error.message);
    }
  }

  console.log('');

  // ============================================================
  // TEST SUITE 4: Foreign Key Behavior
  // ============================================================
  console.log('🔗 TEST SUITE 4: Foreign Key Behavior');
  console.log('-'.repeat(70));

  // Test 4.1: CASCADE Delete
  start = startTest('CASCADE Delete on User');
  try {
    // Create temporary user
    const tempUser = await db.execute(sql`
      INSERT INTO users (username, email, password)
      VALUES ('temp_user_cascade_test', 'temp@test.com', 'password')
      ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email
      RETURNING id;
    `);
    const tempUserId = tempUser.rows[0].id;

    // Add preferences for temp user
    await db.insert(userFixPreferences).values({
      userId: tempUserId,
      checkId: 'CKV_CASCADE_TEST',
      resourceType: 'test',
      fixSnippet: 'test',
      source: 'user_verified',
      timesUsed: 0,
      successCount: 0,
      failureCount: 0,
    });

    // Count preferences
    const beforeCount = await db.execute(sql`
      SELECT COUNT(*) as count FROM user_fix_preferences
      WHERE user_id = ${tempUserId};
    `);

    // Delete user
    await db.execute(sql`DELETE FROM users WHERE id = ${tempUserId};`);

    // Check preferences were deleted
    const afterCount = await db.execute(sql`
      SELECT COUNT(*) as count FROM user_fix_preferences
      WHERE user_id = ${tempUserId};
    `);

    const cascaded = parseInt(beforeCount.rows[0].count) > 0 &&
                     parseInt(afterCount.rows[0].count) === 0;

    endTest('CASCADE Delete on User', start, cascaded, undefined,
      `Preferences auto-deleted: ${cascaded ? 'Yes' : 'No'}`);
  } catch (error: any) {
    endTest('CASCADE Delete on User', start, false, error.message);
  }

  // Test 4.2: Invalid User ID
  start = startTest('Invalid User ID Rejection');
  try {
    let rejected = false;
    try {
      await db.insert(userFixPreferences).values({
        userId: 'nonexistent-user-id-12345',
        checkId: 'CKV_INVALID_USER',
        resourceType: 'test',
        fixSnippet: 'test',
        source: 'user_verified',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      });
    } catch {
      rejected = true; // Should fail - foreign key constraint
    }

    endTest('Invalid User ID Rejection', start, rejected, undefined,
      'Correctly rejected invalid user_id');
  } catch (error: any) {
    endTest('Invalid User ID Rejection', start, false, error.message);
  }

  console.log('');

  // ============================================================
  // TEST SUITE 5: CRUD Operations
  // ============================================================
  console.log('🔄 TEST SUITE 5: CRUD Operations');
  console.log('-'.repeat(70));

  if (testUserId) {
    let testRecordId: string | undefined;

    // Test 5.1: Create
    start = startTest('CREATE Operation');
    try {
      const result = await db.insert(userFixPreferences).values({
        userId: testUserId,
        checkId: 'CKV_CRUD_TEST',
        resourceType: 'azurerm_storage_account',
        fixSnippet: 'allow_nested_items_to_be_public = false',
        confidence: 0.90,
        source: 'checkov',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      }).returning();

      testRecordId = result[0]?.id;
      endTest('CREATE Operation', start, !!testRecordId, undefined,
        `Record ID: ${testRecordId?.substring(0, 8)}...`);
    } catch (error: any) {
      endTest('CREATE Operation', start, false, error.message);
    }

    // Test 5.2: Read
    start = startTest('READ Operation');
    try {
      const result = await db.select()
        .from(userFixPreferences)
        .where(eq(userFixPreferences.id, testRecordId!));

      endTest('READ Operation', start, result.length === 1, undefined,
        `Found record: ${result[0]?.checkId}`);
    } catch (error: any) {
      endTest('READ Operation', start, false, error.message);
    }

    // Test 5.3: Update
    start = startTest('UPDATE Operation');
    try {
      await db.update(userFixPreferences)
        .set({
          timesUsed: 5,
          successCount: 4,
          failureCount: 1,
          confidence: 0.85,
        })
        .where(eq(userFixPreferences.id, testRecordId!));

      const updated = await db.select()
        .from(userFixPreferences)
        .where(eq(userFixPreferences.id, testRecordId!));

      const correct = updated[0]?.timesUsed === 5 &&
                     updated[0]?.successCount === 4 &&
                     updated[0]?.confidence === 0.85;

      endTest('UPDATE Operation', start, correct, undefined,
        `Updated: timesUsed=${updated[0]?.timesUsed}, confidence=${updated[0]?.confidence}`);
    } catch (error: any) {
      endTest('UPDATE Operation', start, false, error.message);
    }

    // Test 5.4: Delete
    start = startTest('DELETE Operation');
    try {
      await db.delete(userFixPreferences)
        .where(eq(userFixPreferences.id, testRecordId!));

      const deleted = await db.select()
        .from(userFixPreferences)
        .where(eq(userFixPreferences.id, testRecordId!));

      endTest('DELETE Operation', start, deleted.length === 0, undefined,
        'Record successfully deleted');
    } catch (error: any) {
      endTest('DELETE Operation', start, false, error.message);
    }
  }

  console.log('');

  // ============================================================
  // TEST SUITE 6: Edge Cases
  // ============================================================
  console.log('🔬 TEST SUITE 6: Edge Cases');
  console.log('-'.repeat(70));

  if (testUserId) {
    // Test 6.1: Very Long Fix Snippet
    start = startTest('Long Fix Snippet (10KB)');
    try {
      const longSnippet = 'a'.repeat(10000);
      await db.insert(userFixPreferences).values({
        userId: testUserId,
        checkId: 'CKV_LONG_SNIPPET',
        resourceType: 'test',
        fixSnippet: longSnippet,
        source: 'ai_generated',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      });

      const result = await db.select()
        .from(userFixPreferences)
        .where(
          and(
            eq(userFixPreferences.userId, testUserId),
            eq(userFixPreferences.checkId, 'CKV_LONG_SNIPPET')
          )
        );

      endTest('Long Fix Snippet (10KB)', start, result[0]?.fixSnippet.length === 10000, undefined,
        `Stored ${result[0]?.fixSnippet.length} characters`);
    } catch (error: any) {
      endTest('Long Fix Snippet (10KB)', start, false, error.message);
    }

    // Test 6.2: Special Characters
    start = startTest('Special Characters in Data');
    try {
      await db.insert(userFixPreferences).values({
        userId: testUserId,
        checkId: "CKV_SPECIAL_'CHARS\"TEST",
        resourceType: 'test_<>_resource',
        fixSnippet: 'fix = "value with \'quotes\' and \\"escapes\\"";',
        source: 'user_verified',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      });

      endTest('Special Characters in Data', start, true, undefined,
        'Handled special characters correctly');
    } catch (error: any) {
      endTest('Special Characters in Data', start, false, error.message);
    }

    // Test 6.3: Duplicate Check (same user, check, resource)
    start = startTest('Duplicate Record Handling');
    try {
      // Insert first
      await db.insert(userFixPreferences).values({
        userId: testUserId,
        checkId: 'CKV_DUPLICATE_TEST',
        resourceType: 'test_resource',
        fixSnippet: 'fix1',
        source: 'user_verified',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      });

      // Insert duplicate (should succeed - no unique constraint)
      await db.insert(userFixPreferences).values({
        userId: testUserId,
        checkId: 'CKV_DUPLICATE_TEST',
        resourceType: 'test_resource',
        fixSnippet: 'fix2',
        source: 'user_verified',
        timesUsed: 0,
        successCount: 0,
        failureCount: 0,
      });

      const count = await db.select()
        .from(userFixPreferences)
        .where(
          and(
            eq(userFixPreferences.userId, testUserId),
            eq(userFixPreferences.checkId, 'CKV_DUPLICATE_TEST')
          )
        );

      endTest('Duplicate Record Handling', start, count.length === 2, undefined,
        `Allows duplicates: ${count.length} records found`);
    } catch (error: any) {
      endTest('Duplicate Record Handling', start, false, error.message);
    }
  }

  console.log('');

  // ============================================================
  // Cleanup Test Data
  // ============================================================
  console.log('🧹 Cleaning up test data...');
  if (testUserId) {
    try {
      await db.delete(userFixPreferences)
        .where(eq(userFixPreferences.userId, testUserId));
      console.log('   ✅ Test data cleaned up\n');
    } catch (error) {
      console.log('   ⚠️  Could not clean up test data\n');
    }
  }

  // ============================================================
  // Final Report
  // ============================================================
  console.log('='.repeat(70));
  console.log('📊 VALIDATION REPORT');
  console.log('='.repeat(70));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const successRate = ((passed / total) * 100).toFixed(1);

  console.log(`\n✅ Passed: ${passed}/${total} (${successRate}%)`);
  console.log(`❌ Failed: ${failed}/${total}`);

  if (failed > 0) {
    console.log('\n⚠️  Failed Tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`   - ${r.name}: ${r.error}`);
    });
  }

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / total;
  console.log(`\n⏱️  Average test duration: ${avgDuration.toFixed(1)}ms`);

  console.log('\n' + '='.repeat(70));

  if (passed === total) {
    console.log('🎉 ALL TESTS PASSED! Phase 1 is production-ready.');
  } else {
    console.log('⚠️  Some tests failed. Review errors above.');
  }

  return passed === total;
}

// Run validation
validatePhase1()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error('\n💥 Validation crashed:', error);
    process.exit(1);
  });
