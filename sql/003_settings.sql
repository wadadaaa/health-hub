-- Runtime configuration that would otherwise live in environment variables.
--
-- Changing an env var on this deployment means editing the compose file in a
-- web panel and redeploying; keeping credentials here instead lets them be set
-- over the API, which matters for anything added after the first deploy.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
