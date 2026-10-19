/**
 * Oura OAuth2 (authorization code + PKCE).
 *
 * Oura deprecated personal access tokens, so the integration holds an
 * access/refresh pair in `oauth_tokens`. Refresh tokens are single-use: every
 * refresh returns a new one, and the write below replaces the row atomically.
 *
 * https://cloud.ouraring.com/docs/authentication
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './db.js';

const PROVIDER = 'oura';
const AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
const TOKEN_URL = 'https://api.ouraring.com/oauth/token';

/** Everything the ingest needs; `daily` covers activity/sleep/readiness summaries. */
const SCOPES = ['daily', 'personal', 'workout', 'session'];

/** Refresh this long before the token actually expires. */
const REFRESH_SKEW_MS = 120_000;

/** A flow older than this can no longer be completed. */
const FLOW_TTL_MS = 10 * 60_000;

export interface OuraOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
}

const base64url = (b: Buffer) => b.toString('base64url');

// ---------- flow start ----------

export interface StartedFlow {
  url: string;
  state: string;
}

export async function startFlow(db: Queryable, config: OuraOAuthConfig): Promise<StartedFlow> {
  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(48)); // 64 chars, within Oura's 43–128
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  await db.query(
    `INSERT INTO oauth_flows (state, provider, code_verifier, redirect_uri) VALUES ($1, $2, $3, $4)`,
    [state, PROVIDER, codeVerifier, config.redirectUri],
  );
  // Housekeeping: drop anything the user abandoned.
  await db.query(`DELETE FROM oauth_flows WHERE created_at < now() - interval '1 hour'`);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state };
}

// ---------- token endpoint ----------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function postToken(config: OuraOAuthConfig, form: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({
    ...form,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Oura token endpoint ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as TokenResponse;
}

async function store(db: Queryable, t: TokenResponse): Promise<StoredTokens> {
  const expiresAt = t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null;
  const { rows } = await db.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
       expires_at    = EXCLUDED.expires_at,
       scope         = COALESCE(EXCLUDED.scope, oauth_tokens.scope),
       updated_at    = now()
     RETURNING access_token, refresh_token, expires_at, scope`,
    [PROVIDER, t.access_token, t.refresh_token ?? null, expiresAt, t.scope ?? null],
  );
  const r = rows[0];
  return {
    access_token: String(r.access_token),
    refresh_token: r.refresh_token == null ? null : String(r.refresh_token),
    expires_at: r.expires_at == null ? null : new Date(String(r.expires_at)).toISOString(),
    scope: r.scope == null ? null : String(r.scope),
  };
}

/** Completes the flow started by `startFlow`. Throws when the state is unknown or stale. */
export async function completeFlow(
  db: Queryable,
  config: OuraOAuthConfig,
  code: string,
  state: string,
): Promise<StoredTokens> {
  const { rows } = await db.query(
    `DELETE FROM oauth_flows WHERE state = $1 AND provider = $2 RETURNING code_verifier, redirect_uri, created_at`,
    [state, PROVIDER],
  );
  const flow = rows[0];
  if (!flow) throw new Error('Unknown or already-used authorization state');
  const startedAt = new Date(String(flow.created_at)).getTime();
  if (Date.now() - startedAt > FLOW_TTL_MS) throw new Error('Authorization took too long; start again');

  const tokens = await postToken(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: String(flow.redirect_uri),
    code_verifier: String(flow.code_verifier),
  });
  return store(db, tokens);
}

// ---------- reading a usable token ----------

export async function readTokens(db: Queryable): Promise<StoredTokens | null> {
  const { rows } = await db.query(
    `SELECT access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE provider = $1`,
    [PROVIDER],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    access_token: String(r.access_token),
    refresh_token: r.refresh_token == null ? null : String(r.refresh_token),
    expires_at: r.expires_at == null ? null : new Date(String(r.expires_at)).toISOString(),
    scope: r.scope == null ? null : String(r.scope),
  };
}

/**
 * A bearer token good for the next couple of minutes, refreshing if needed.
 * Returns null when Oura has never been connected.
 */
export async function getAccessToken(db: Queryable, config: OuraOAuthConfig): Promise<string | null> {
  const current = await readTokens(db);
  if (!current) return null;

  const expiresAt = current.expires_at ? Date.parse(current.expires_at) : null;
  const stillGood = expiresAt == null || expiresAt - REFRESH_SKEW_MS > Date.now();
  if (stillGood) return current.access_token;

  if (!current.refresh_token) {
    throw new Error('Oura access token expired and no refresh token is stored; reconnect Oura');
  }
  const refreshed = await postToken(config, {
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
  });
  const saved = await store(db, refreshed);
  return saved.access_token;
}

export interface OuraStatus {
  connected: boolean;
  expires_at: string | null;
  scope: string | null;
  has_refresh_token: boolean;
}

export async function status(db: Queryable): Promise<OuraStatus> {
  const t = await readTokens(db);
  return {
    connected: t !== null,
    expires_at: t?.expires_at ?? null,
    scope: t?.scope ?? null,
    has_refresh_token: Boolean(t?.refresh_token),
  };
}

export { PROVIDER as OURA_PROVIDER, SCOPES as OURA_SCOPES };
