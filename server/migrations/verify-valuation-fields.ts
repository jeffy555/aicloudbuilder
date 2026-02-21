import "dotenv/config";
import { db } from '../db';
import { sql } from 'drizzle-orm';

async function verify() {
  const result = await db.execute(sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'sessions'
      AND column_name IN ('scanned_resources', 'scan_timestamp')
    ORDER BY column_name
  `);

  console.log('\n✅ Valuation columns in sessions table:');
  console.table(result.rows);
  process.exit(0);
}

verify().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
