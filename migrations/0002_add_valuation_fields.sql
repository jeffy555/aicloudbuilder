-- Add Valuation module fields to sessions table
-- Generated: 2026-02-20

-- Add scanned_resources column (stores JSON string of Azure resources)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'scanned_resources'
    ) THEN
        ALTER TABLE "sessions" ADD COLUMN "scanned_resources" text;
    END IF;
END $$;

-- Add scan_timestamp column (stores ISO timestamp of last scan)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'scan_timestamp'
    ) THEN
        ALTER TABLE "sessions" ADD COLUMN "scan_timestamp" text;
    END IF;
END $$;
