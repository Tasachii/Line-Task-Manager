-- Durable LINE push queue. Retry keys let LINE suppress a duplicate if a request succeeded but
-- the response was lost. Terminal failures remain visible to operators through /health.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL,
  message_text     TEXT NOT NULL,
  retry_key        TEXT UNIQUE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | failed (delivered rows are removed)
  attempts         INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
  ON notification_outbox (status, next_attempt_at)
  WHERE status = 'pending';
