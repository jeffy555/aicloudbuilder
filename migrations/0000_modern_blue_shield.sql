CREATE TABLE "generated_files" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"file_name" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"type" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"provider" text,
	"repository_id" text,
	"repository_name" text,
	"repository_branch" text,
	"cloud_provider" text,
	"module_approach" text,
	"current_step" text DEFAULT '1' NOT NULL,
	"workflow_step" text DEFAULT 'landing' NOT NULL,
	"active_module" text,
	"is_existing_repo" text,
	"detected_cloud_provider" text,
	"detected_module_type" text,
	"detected_terraform_files" jsonb,
	"arch_me_analysis" text,
	"has_backend" text,
	"backend_type" text,
	"backend_storage_account" text,
	"backend_resource_group" text,
	"backend_container" text,
	"backend_state_key" text,
	"backend_location" text,
	"backend_validated" text,
	"backend_declined" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_fix_preferences" (
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
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "generated_files" ADD CONSTRAINT "generated_files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_fix_preferences" ADD CONSTRAINT "user_fix_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_fix_lookup" ON "user_fix_preferences" USING btree ("user_id","check_id","resource_type");--> statement-breakpoint
CREATE INDEX "idx_check_lookup" ON "user_fix_preferences" USING btree ("check_id","resource_type");--> statement-breakpoint
CREATE INDEX "idx_user_times_used" ON "user_fix_preferences" USING btree ("user_id","times_used");