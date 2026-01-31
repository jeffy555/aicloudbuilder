import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function dropTables() {
  const client = await pool.connect();
  
  try {
    console.log("🗑️  Dropping existing tables...");
    
    // Drop tables in correct order (respecting foreign key constraints)
    await client.query("DROP TABLE IF EXISTS generated_files CASCADE;");
    await client.query("DROP TABLE IF EXISTS messages CASCADE;");
    await client.query("DROP TABLE IF EXISTS sessions CASCADE;");
    await client.query("DROP TABLE IF EXISTS users CASCADE;");
    
    console.log("✅ All tables dropped successfully");
  } catch (error) {
    console.error("❌ Error dropping tables:", error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

dropTables()
  .then(() => {
    console.log("✅ Done! You can now run 'npm run db:push'");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Failed:", error);
    process.exit(1);
  });

