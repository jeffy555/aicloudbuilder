import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Migration: Add AWS Cognito SSO column to users (matches shared/schema users.awsSub)
 */
export async function addAwsAuthColumn() {
  try {
    await db.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS aws_sub TEXT
    `);

    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS users_aws_sub_unique ON users (aws_sub)
    `);

    console.log("✅ Migration: add-aws-auth-column completed");
  } catch (error: any) {
    if (error?.code === "42701") {
      console.log("ℹ️  Migration: add-aws-auth-column already applied");
      return;
    }
    throw error;
  }
}
