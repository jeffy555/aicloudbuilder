import "dotenv/config";
import { db } from '../db';
import { sql } from 'drizzle-orm';

async function addValuationFields() {
  console.log('🔄 Adding Valuation module fields to sessions table...');

  try {
    // Check if scanned_resources column exists
    const checkScannedResources = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'scanned_resources'
    `);

    if (checkScannedResources.rows.length === 0) {
      // Add scanned_resources column
      await db.execute(sql`
        ALTER TABLE sessions
        ADD COLUMN scanned_resources TEXT
      `);
      console.log('✅ Added scanned_resources column');
    } else {
      console.log('ℹ️  scanned_resources column already exists');
    }

    // Check if scan_timestamp column exists
    const checkScanTimestamp = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'scan_timestamp'
    `);

    if (checkScanTimestamp.rows.length === 0) {
      // Add scan_timestamp column
      await db.execute(sql`
        ALTER TABLE sessions
        ADD COLUMN scan_timestamp TEXT
      `);
      console.log('✅ Added scan_timestamp column');
    } else {
      console.log('ℹ️  scan_timestamp column already exists');
    }

    console.log('✅ Migration completed successfully!');
  } catch (error: any) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
}

addValuationFields()
  .then(() => {
    console.log('✅ Done!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Failed:', err);
    process.exit(1);
  });
