ALTER TABLE accounts
  ADD CONSTRAINT balance_non_negative CHECK (balance_minor >= 0);

ALTER TABLE transfers
  ADD CONSTRAINT transfer_amount_positive CHECK (amount_minor > 0),
  ADD CONSTRAINT transfer_different_accounts CHECK (from_account_id <> to_account_id),
  ADD CONSTRAINT transfer_status_valid CHECK (status IN ('completed', 'failed'));

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_amount_positive CHECK (amount_minor > 0),
  ADD CONSTRAINT ledger_direction_valid CHECK (direction IN ('debit', 'credit'));