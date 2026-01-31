-- Phase 1: Add user_fix_preferences table
-- Generated: 2026-01-31

-- Create table only if it doesn't exist
CREATE TABLE IF NOT EXISTS "user_fix_preferences" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"check_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"fix_snippet" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"times_used" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

-- Add foreign key constraint (skip if already exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_fix_preferences_user_id_users_id_fk'
    ) THEN
        ALTER TABLE "user_fix_preferences"
        ADD CONSTRAINT "user_fix_preferences_user_id_users_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
    END IF;
END $$;

-- Create indexes (skip if already exist)
CREATE INDEX IF NOT EXISTS "idx_user_fix_lookup" ON "user_fix_preferences" USING btree ("user_id","check_id","resource_type");
CREATE INDEX IF NOT EXISTS "idx_check_lookup" ON "user_fix_preferences" USING btree ("check_id","resource_type");
CREATE INDEX IF NOT EXISTS "idx_user_times_used" ON "user_fix_preferences" USING btree ("user_id","times_used");
