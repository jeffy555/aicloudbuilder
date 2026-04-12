import { db } from '../db.js';
import { sql } from 'drizzle-orm';

async function migrate() {
  console.log('Creating build_history table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS build_history (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR REFERENCES users(id),
      session_id VARCHAR NOT NULL REFERENCES sessions(id),
      module TEXT NOT NULL,
      build_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      stages JSONB,
      pipeline_stages JSONB,
      total_duration_ms INTEGER,
      files_generated INTEGER,
      repository_name TEXT,
      repository_branch TEXT,
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      completed_at TIMESTAMP
    )
  `);

  console.log('Creating indexes...');

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_build_history_user_module ON build_history(user_id, module)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_build_history_session ON build_history(session_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_build_history_build_id ON build_history(build_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_build_history_created ON build_history(created_at)
  `);

  console.log('build_history table created successfully.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
