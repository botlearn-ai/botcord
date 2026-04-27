-- Migration: Add room_id to agent_subscriptions for room-scoped subscription tracking.
--
-- The new column lets the billing loop compare a subscription's bound room
-- (`room_id`) against the room's current `required_subscription_product_id` and
-- cancel mismatched subscriptions when a room owner changes the plan. The FK
-- uses ON DELETE SET NULL so that existing audit/charge history is preserved
-- even after a room is deleted; application paths must pre-cancel subscriptions
-- before deletion (see hub services for room dissolve).

ALTER TABLE agent_subscriptions
    ADD COLUMN IF NOT EXISTS room_id VARCHAR(64)
    REFERENCES rooms(room_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_agent_subscriptions_room_id
    ON agent_subscriptions(room_id);

-- Backfill room_id for legacy active/past_due subscriptions where exactly
-- one room currently references their product. The plan-change cancel path
-- in `_charge_subscription` gates on `room_id IS NOT NULL`; without this
-- backfill, pre-existing subscriptions would keep auto-renewing on archived
-- products after a migrate-plan or paid-access toggle-off. Subs whose product
-- is referenced by zero or multiple rooms are left NULL (genuinely ambiguous).
UPDATE agent_subscriptions AS s
SET room_id = (
    SELECT r.room_id
    FROM rooms r
    WHERE r.required_subscription_product_id = s.product_id
)
WHERE s.room_id IS NULL
  AND s.status IN ('active', 'past_due')
  AND (
    SELECT COUNT(*) FROM rooms r
    WHERE r.required_subscription_product_id = s.product_id
  ) = 1;
