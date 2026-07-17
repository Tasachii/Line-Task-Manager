-- Soft-delete flag: a deleted card is hidden from the board (findAll/findById filter it out)
-- but the row is kept for history rather than hard-deleted.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
