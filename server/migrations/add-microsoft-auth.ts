import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Migration: Add Microsoft Azure AD SSO fields to users table
 * - microsoft_id: nullable unique column for the Microsoft OID/sub claim
 * - auth_provider: 'local' | 'microsoft' — how the user was created
 * - password becomes nullable so SSO-only users don't need one
 */
export async function addMicrosoftAuth() {
  try {
    await db.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS microsoft_id TEXT UNIQUE,
        ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local'
    `);

    // Make password nullable for SSO users
    await db.execute(sql`
      ALTER TABLE users
        ALTER COLUMN password DROP NOT NULL
    `);

    console.log("✅ Migration: add-microsoft-auth completed");
  } catch (error: any) {
    // Column already exists — safe to ignore
    if (error?.code === "42701") {
      console.log("ℹ️  Migration: add-microsoft-auth already applied");
      return;
    }
    throw error;
  }
}
