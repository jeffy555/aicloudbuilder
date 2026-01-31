#!/usr/bin/env tsx
/**
 * Phase 1: Apply Migration Script
 *
 * Safely applies the user_fix_preferences table migration
 */

import 'dotenv/config';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';

async function applyMigration() {
  console.log('📦 Phase 1: Applying user_fix_preferences migration...\n');

  try {
    // Read the migration file
    const migrationPath = path.join(process.cwd(), 'migrations', '0001_add_user_fix_preferences.sql');
    const migrationSQL = await fs.readFile(migrationPath, 'utf-8');

    console.log('🔍 Checking if table already exists...');

    // Check if table exists
    const tableCheck = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'user_fix_preferences'
      );
    `);

    const tableExists = tableCheck.rows[0]?.exists;

    if (tableExists) {
      console.log('✅ Table user_fix_preferences already exists');
      console.log('   Skipping migration (table is up to date)\n');

      // Verify indexes exist
      console.log('🔍 Verifying indexes...');
      const indexes = await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'user_fix_preferences';
      `);

      console.log(`   Found ${indexes.rows.length} index(es):`);
      for (const row of indexes.rows) {
        console.log(`   - ${row.indexname}`);
      }

      return;
    }

    console.log('⚙️  Creating user_fix_preferences table...\n');

    // Execute the migration
    await db.execute(sql.raw(migrationSQL));

    console.log('✅ Migration applied successfully!\n');

    // Verify table was created
    console.log('🔍 Verifying table structure...');

    const columns = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'user_fix_preferences'
      ORDER BY ordinal_position;
    `);

    console.log(`   Table has ${columns.rows.length} column(s):`);
    for (const col of columns.rows) {
      console.log(`   - ${col.column_name}: ${col.data_type}${col.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
    }

    // Check indexes
    const indexes = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'user_fix_preferences';
    `);

    console.log(`\n   Created ${indexes.rows.length} index(es):`);
    for (const row of indexes.rows) {
      console.log(`   - ${row.indexname}`);
    }

    // Check foreign keys
    const foreignKeys = await db.execute(sql`
      SELECT
        con.conname as constraint_name,
        att.attname as column_name
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
      WHERE con.conrelid = 'user_fix_preferences'::regclass
      AND con.contype = 'f';
    `);

    console.log(`\n   Created ${foreignKeys.rows.length} foreign key(s):`);
    for (const row of foreignKeys.rows) {
      console.log(`   - ${row.constraint_name} on ${row.column_name}`);
    }

    console.log('\n✅ Phase 1 migration complete!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  }
}

// Run migration
applyMigration()
  .then(() => {
    console.log('\n🎉 All done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Error:', error);
    process.exit(1);
  });
