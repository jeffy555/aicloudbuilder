import "dotenv/config";
import { db } from "../db";
import { sql } from "drizzle-orm";

async function addRepositoryBranch() {
  console.log("🔄 Ensuring repository_branch exists on sessions table...");

  try {
    const existingColumn = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'repository_branch'
    `);

    if (existingColumn.rows.length === 0) {
      console.log("   ➕ Adding repository_branch column...");
      await db.execute(sql`
        ALTER TABLE sessions
        ADD COLUMN repository_branch TEXT
      `);
      console.log("✅ repository_branch column added");
    } else {
      console.log("ℹ️  repository_branch column already exists");
    }

    console.log("✅ Migration completed successfully!");
  } catch (error: any) {
    console.error("❌ Migration failed:", error.message);
    throw error;
  }
}

addRepositoryBranch()
  .then(() => {
    console.log("✅ Done!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
  });



