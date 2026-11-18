-- A reviewer can acknowledge the specific immutable policy receipts that blocked release.
ALTER TABLE promotions
    ADD COLUMN policy_override jsonb,
    ADD COLUMN policy_approval_promotion_id uuid REFERENCES promotions(id);
