ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "beta_access" boolean,
  ADD COLUMN IF NOT EXISTS "beta_admin" boolean;
--> statement-breakpoint
ALTER TABLE "users"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "status" SET DEFAULT 'active',
  ALTER COLUMN "max_agents" SET DEFAULT 10,
  ALTER COLUMN "created_at" SET DEFAULT now(),
  ALTER COLUMN "updated_at" SET DEFAULT now(),
  ALTER COLUMN "beta_access" SET DEFAULT false,
  ALTER COLUMN "beta_admin" SET DEFAULT false;
--> statement-breakpoint
UPDATE "users"
SET
  "status" = COALESCE("status", 'active'),
  "max_agents" = COALESCE("max_agents", 10),
  "created_at" = COALESCE("created_at", now()),
  "updated_at" = COALESCE("updated_at", now()),
  "beta_access" = COALESCE("beta_access", false),
  "beta_admin" = COALESCE("beta_admin", false)
WHERE
  "status" IS NULL OR
  "max_agents" IS NULL OR
  "created_at" IS NULL OR
  "updated_at" IS NULL OR
  "beta_access" IS NULL OR
  "beta_admin" IS NULL;
--> statement-breakpoint
ALTER TABLE "users"
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "max_agents" SET NOT NULL,
  ALTER COLUMN "created_at" SET NOT NULL,
  ALTER COLUMN "updated_at" SET NOT NULL,
  ALTER COLUMN "beta_access" SET NOT NULL,
  ALTER COLUMN "beta_admin" SET NOT NULL;
