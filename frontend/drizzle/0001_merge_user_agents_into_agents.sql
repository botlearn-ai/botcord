ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "user_id" uuid,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "agent_token" text,
  ADD COLUMN IF NOT EXISTS "token_expires_at" timestamp with time zone;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agents_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "agents"
      ADD CONSTRAINT "agents_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "agents" ("agent_id", "display_name", "created_at")
SELECT
  ua."agent_id",
  ua."display_name",
  COALESCE(ua."claimed_at", now())
FROM "user_agents" AS ua
LEFT JOIN "agents" AS a
  ON a."agent_id" = ua."agent_id"
WHERE a."agent_id" IS NULL;
--> statement-breakpoint
UPDATE "agents" AS a
SET
  "user_id" = ua."user_id",
  "claimed_at" = ua."claimed_at",
  "is_default" = ua."is_default",
  "agent_token" = ua."agent_token",
  "token_expires_at" = ua."token_expires_at"
FROM "user_agents" AS ua
WHERE a."agent_id" = ua."agent_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_user_id_idx" ON "agents" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_user_default_unique"
  ON "agents" USING btree ("user_id")
  WHERE "is_default" = true AND "user_id" IS NOT NULL;
--> statement-breakpoint
DROP TABLE IF EXISTS "user_agents";
