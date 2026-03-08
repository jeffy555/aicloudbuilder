import "dotenv/config";
import { db } from '../db';
import { sql } from 'drizzle-orm';

async function addRgMetricsFields() {
  console.log('🔄 Adding selected_resource_groups and usage_metrics_cache to sessions table...');

  try {
    // selected_resource_groups
    const checkRg = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'selected_resource_groups'
    `);

    if (checkRg.rows.length === 0) {
      await db.execute(sql`ALTER TABLE sessions ADD COLUMN selected_resource_groups TEXT`);
      console.log('✅ Added selected_resource_groups column');
    } else {
      console.log('ℹ️  selected_resource_groups already exists');
    }

    // usage_metrics_cache
    const checkMetrics = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'usage_metrics_cache'
    `);

    if (checkMetrics.rows.length === 0) {
      await db.execute(sql`ALTER TABLE sessions ADD COLUMN usage_metrics_cache TEXT`);
      console.log('✅ Added usage_metrics_cache column');
    } else {
      console.log('ℹ️  usage_metrics_cache already exists');
    }

    console.log('✅ Migration completed successfully!');
  } catch (error: any) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
}

addRgMetricsFields()
  .then(() => { console.log('✅ Done!'); process.exit(0); })
  .catch((err) => { console.error('❌ Failed:', err); process.exit(1); });
