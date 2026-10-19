-- OAuth2 tokens, one row per provider. Oura deprecated personal access tokens,
-- so the Oura integration now holds an access/refresh pair and rotates it.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider      TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  scope         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived state for an in-flight authorization code flow (PKCE verifier +
-- CSRF state). Rows are deleted on use and expire on their own.
CREATE TABLE IF NOT EXISTS oauth_flows (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
