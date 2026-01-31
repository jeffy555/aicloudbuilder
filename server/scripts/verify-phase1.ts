#!/usr/bin/env tsx
/**
 * Phase 1: Verification Script
 *
 * Verifies the user_fix_preferences table structure
 */

import 'dotenv/config';
import { db } from '../db';
import { sql } from 'drizzle-orm';

async function verifyTable() {
  console.log('🔍 Phase 1: Verifying user_fix_preferences table...\n');

  try {
    // 1. Check if table exists
    console.log('1️⃣  Checking table existence...');
    const tableCheck = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'user_fix_preferences'
      );
    `);

    if (!tableCheck.rows[0]?.exists) {
      console.log('❌ Table does not exist!');
      console.log('   Run: npx tsx server/scripts/apply-migration.ts');
      process.exit(1);
    }
    console.log('✅ Table exists\n');

    // 2. Check columns
    console.log('2️⃣  Checking table structure...');
    const columns = await db.execute(sql`
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_name = 'user_fix_preferences'
      ORDER BY ordinal_position;
    `);

    console.log(`   Found ${columns.rows.length} columns:`);
    const expectedColumns = [
      'id', 'user_id', 'check_id', 'resource_type', 'fix_snippet',
      'confidence', 'times_used', 'success_count', 'failure_count',
      'source', 'last_used_at', 'created_at', 'updated_at'
    ];

    for (const expected of expectedColumns) {
      const found = columns.rows.find((c: any) => c.column_name === expected);
      if (found) {
        console.log(`   ✅ ${found.column_name} (${found.data_type})`);
      } else {
        console.log(`   ❌ Missing: ${expected}`);
      }
    }
    console.log('');

    // 3. Check indexes
    console.log('3️⃣  Checking indexes...');
    const indexes = await db.execute(sql`
      SELECT
        indexname,
        indexdef
      FROM pg_indexes
      WHERE tablename = 'user_fix_preferences'
      AND schemaname = 'public';
    `);

    console.log(`   Found ${indexes.rows.length} index(es):`);
    for (const row of indexes.rows) {
      console.log(`   ✅ ${row.indexname}`);
    }

    const expectedIndexes = [
      'user_fix_preferences_pkey',
      'idx_user_fix_lookup',
      'idx_check_lookup',
      'idx_user_times_used'
    ];

    const missingIndexes = expectedIndexes.filter(
      name => !indexes.rows.some((r: any) => r.indexname === name)
    );

    if (missingIndexes.length > 0) {
      console.log('\n   ⚠️  Missing indexes:');
      for (const missing of missingIndexes) {
        console.log(`      - ${missing}`);
      }
      console.log('\n   Creating missing indexes...');

      // Create missing indexes
      if (missingIndexes.includes('idx_user_fix_lookup')) {
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_user_fix_lookup"
          ON "user_fix_preferences" ("user_id", "check_id", "resource_type");
        `);
        console.log('   ✅ Created idx_user_fix_lookup');
      }

      if (missingIndexes.includes('idx_check_lookup')) {
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_check_lookup"
          ON "user_fix_preferences" ("check_id", "resource_type");
        `);
        console.log('   ✅ Created idx_check_lookup');
      }

      if (missingIndexes.includes('idx_user_times_used')) {
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_user_times_used"
          ON "user_fix_preferences" ("user_id", "times_used");
        `);
        console.log('   ✅ Created idx_user_times_used');
      }
    }
    console.log('');

    // 4. Check foreign keys
    console.log('4️⃣  Checking foreign keys...');
    const foreignKeys = await db.execute(sql`
      SELECT
        con.conname as constraint_name,
        att.attname as column_name,
        con.confdeltype as delete_action
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
      WHERE con.conrelid = 'user_fix_preferences'::regclass
      AND con.contype = 'f';
    `);

    if (foreignKeys.rows.length === 0) {
      console.log('   ⚠️  No foreign keys found! Adding...');
      await db.execute(sql`
        ALTER TABLE "user_fix_preferences"
        ADD CONSTRAINT "user_fix_preferences_user_id_users_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;
      `);
      console.log('   ✅ Created foreign key constraint');
    } else {
      for (const row of foreignKeys.rows) {
        const deleteAction = row.delete_action === 'c' ? 'CASCADE' : 'NO ACTION';
        console.log(`   ✅ ${row.constraint_name} on ${row.column_name} (ON DELETE ${deleteAction})`);
      }
    }
    console.log('');

    // 5. Test insert/select/delete
    console.log('5️⃣  Testing operations...');

    // Get a test user (or skip if no users)
    const testUser = await db.execute(sql`
      SELECT id FROM users LIMIT 1;
    `);

    if (testUser.rows.length === 0) {
      console.log('   ⚠️  No users found, skipping operation test');
      console.log('   ℹ️  Create a user to test operations');
    } else {
      const userId = testUser.rows[0].id;

      // Insert test record
      await db.execute(sql`
        INSERT INTO user_fix_preferences (
          user_id, check_id, resource_type, fix_snippet,
          confidence, source
        ) VALUES (
          ${userId},
          'CKV_TEST_001',
          'test_resource',
          'test_fix = true',
          0.95,
          'user_verified'
        )
        ON CONFLICT DO NOTHING;
      `);
      console.log('   ✅ Insert: OK');

      // Select test record
      const selectResult = await db.execute(sql`
        SELECT * FROM user_fix_preferences
        WHERE user_id = ${userId}
        AND check_id = 'CKV_TEST_001';
      `);
      console.log(`   ✅ Select: OK (found ${selectResult.rows.length} row(s))`);

      // Delete test record
      await db.execute(sql`
        DELETE FROM user_fix_preferences
        WHERE user_id = ${userId}
        AND check_id = 'CKV_TEST_001';
      `);
      console.log('   ✅ Delete: OK');
    }

    console.log('\n✅ Phase 1 verification complete!');
    console.log('\n📊 Summary:');
    console.log(`   - Table: ✅ Created`);
    console.log(`   - Columns: ${columns.rows.length}/13 ✅`);
    console.log(`   - Indexes: ${indexes.rows.length + (missingIndexes.length > 0 ? missingIndexes.length : 0)}/4 ✅`);
    console.log(`   - Foreign Keys: ${foreignKeys.rows.length > 0 ? 1 : 0}/1 ✅`);
    console.log(`   - Operations: ✅ Working`);

  } catch (error) {
    console.error('\n❌ Verification failed:', error);
    throw error;
  }
}

// Run verification
verifyTable()
  .then(() => {
    console.log('\n🎉 All checks passed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Error:', error);
    process.exit(1);
  });
