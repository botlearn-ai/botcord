ALTER TABLE "users"
  ALTER COLUMN "max_agents" SET DEFAULT 30;
--> statement-breakpoint
UPDATE "users"
SET "max_agents" = 30;
