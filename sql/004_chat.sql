-- The bot's short-term memory: the recent turns of the Telegram conversation,
-- so a correction ("without the oil") or a reference ("same as yesterday")
-- lands against something rather than arriving out of nowhere.
--
-- Only what the model needs to read back is kept: the role and the content
-- blocks of each turn, exactly as the Messages API wants them. Photos are not
-- stored -- the image bytes stay in Telegram and only the text of what was
-- decided survives, which is also what keeps this table small.

CREATE TABLE IF NOT EXISTS chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    TEXT        NOT NULL,
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_chat_idx ON chat_messages (chat_id, id);
