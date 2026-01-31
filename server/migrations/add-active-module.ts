import "dotenv/config";
import { db } from "../db";
import { sql } from "drizzle-orm";

async function addActiveModule() {
  console.log("🔄 Ensuring active_module exists on sessions table...");

  try {
    const existingColumn = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'active_module'
    `);

    if (existingColumn.rows.length === 0) {
      console.log("   ➕ Adding active_module column...");
      await db.execute(sql`
        ALTER TABLE sessions
        ADD COLUMN active_module TEXT
      `);
      console.log("✅ active_module column added");
    } else {
      console.log("ℹ️  active_module column already exists");
    }

    console.log("✅ Migration completed successfully!");
  } catch (error: any) {
    console.error("❌ Migration failed:", error.message);
    throw error;
  }
}

addActiveModule()
  .then(() => {
    console.log("✅ Done!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Failed:", err);
    process.exit(1);
  });


