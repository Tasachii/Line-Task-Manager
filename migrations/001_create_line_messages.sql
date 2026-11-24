-- Claims LINE message IDs for deduplication. Content is retained only for messages that create tasks.
CREATE TABLE IF NOT EXISTS line_messages (
  message_id  TEXT PRIMARY KEY,            -- messageId from LINE (prevents duplicates on webhook retry)
  group_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_messages_group ON line_messages (group_id);
