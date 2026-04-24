-- Migration: Rename wallet ownership columns from agent_id -> owner_id
--
-- Owner id may be an agent (`ag_*`) or a human (`hu_*`). The FKs to agents
-- are dropped; existence is validated in the service layer based on prefix.
-- Column shapes (VARCHAR(32)) are unchanged — ag_/hu_ prefixes share one
-- namespace.

-- wallet_accounts ------------------------------------------------------------
ALTER TABLE wallet_accounts DROP CONSTRAINT IF EXISTS wallet_accounts_agent_id_fkey;
ALTER TABLE wallet_accounts RENAME COLUMN agent_id TO owner_id;
ALTER TABLE wallet_accounts RENAME CONSTRAINT uq_wallet_agent_asset TO uq_wallet_owner_asset;
ALTER INDEX IF EXISTS ix_wallet_accounts_agent_id RENAME TO ix_wallet_accounts_owner_id;

-- wallet_entries -------------------------------------------------------------
ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_agent_id_fkey;
ALTER TABLE wallet_entries RENAME COLUMN agent_id TO owner_id;
ALTER INDEX IF EXISTS ix_wallet_entries_agent_id RENAME TO ix_wallet_entries_owner_id;

-- wallet_transactions --------------------------------------------------------
ALTER TABLE wallet_transactions RENAME COLUMN from_agent_id TO from_owner_id;
ALTER TABLE wallet_transactions RENAME COLUMN to_agent_id TO to_owner_id;
ALTER TABLE wallet_transactions RENAME COLUMN initiator_agent_id TO initiator_owner_id;
ALTER INDEX IF EXISTS ix_wallet_transactions_from_agent_id RENAME TO ix_wallet_transactions_from_owner_id;
ALTER INDEX IF EXISTS ix_wallet_transactions_to_agent_id RENAME TO ix_wallet_transactions_to_owner_id;
ALTER INDEX IF EXISTS ix_wallet_transactions_initiator_agent_id RENAME TO ix_wallet_transactions_initiator_owner_id;
-- uq_tx_idem references initiator column: Postgres tracks the column by OID,
-- so the unique constraint follows the rename automatically.

-- topup_requests -------------------------------------------------------------
ALTER TABLE topup_requests DROP CONSTRAINT IF EXISTS topup_requests_agent_id_fkey;
ALTER TABLE topup_requests RENAME COLUMN agent_id TO owner_id;
ALTER INDEX IF EXISTS ix_topup_requests_agent_id RENAME TO ix_topup_requests_owner_id;

-- withdrawal_requests --------------------------------------------------------
ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_agent_id_fkey;
ALTER TABLE withdrawal_requests RENAME COLUMN agent_id TO owner_id;
ALTER INDEX IF EXISTS ix_withdrawal_requests_agent_id RENAME TO ix_withdrawal_requests_owner_id;
