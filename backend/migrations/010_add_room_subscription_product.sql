-- Migration: add optional subscription-gated access to rooms

ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS required_subscription_product_id VARCHAR(64);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_rooms_required_subscription_product'
    ) THEN
        ALTER TABLE rooms
            ADD CONSTRAINT fk_rooms_required_subscription_product
            FOREIGN KEY (required_subscription_product_id)
            REFERENCES subscription_products(product_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_rooms_required_subscription_product_id
    ON rooms(required_subscription_product_id);
