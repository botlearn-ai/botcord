ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "claim_code" varchar(64);
--> statement-breakpoint
ALTER TABLE "agents"
  ALTER COLUMN "claim_code" SET DEFAULT ('clm_' || replace(gen_random_uuid()::text, '-', ''));
--> statement-breakpoint
UPDATE "agents"
SET "claim_code" = 'clm_' || replace(gen_random_uuid()::text, '-', '')
WHERE "claim_code" IS NULL;
--> statement-breakpoint
ALTER TABLE "agents"
  ALTER COLUMN "claim_code" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_claim_code_unique"
  ON "agents" USING btree ("claim_code");
