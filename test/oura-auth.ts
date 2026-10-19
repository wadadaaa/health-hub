/**
 * Oura OAuth2 flow against an in-memory Postgres and a stubbed token endpoint.
 *   npx tsx test/oura-auth.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newDb } from 'pg-mem';
import { migrate, type Queryable } from '../src/db.js';
import { completeFlow, getAccessToken, readTokens, startFlow, status } from '../src/oura-auth.js';

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const db = new Pool() as unknown as Queryable;
await migrate(db);

const config = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://example.test/oura/callback',
};

// --- stub the token endpoint ---
const calls: { body: Record<string, string> }[] = [];
let nextResponse: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  assert.equal(String(url), 'https://api.ouraring.com/oauth/token');
  calls.push({ body: Object.fromEntries(new URLSearchParams(String(init?.body))) });
  return new Response(JSON.stringify(nextResponse), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

try {
  // 1. The authorize URL carries PKCE and a state we stored.
  const started = await startFlow(db, config);
  const u = new URL(started.url);
  assert.equal(u.origin + u.pathname, 'https://cloud.ouraring.com/oauth/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('scope')?.includes('daily'));
  assert.equal(u.searchParams.get('state'), started.state);
  const challenge = u.searchParams.get('code_challenge')!;
  console.log('authorize url ok');

  // 2. An unknown state is refused.
  await assert.rejects(() => completeFlow(db, config, 'code', 'not-a-real-state'), /Unknown or already-used/);

  // 3. The exchange sends the verifier matching the challenge, and stores tokens.
  nextResponse = { access_token: 'at1', refresh_token: 'rt1', expires_in: 86400, scope: 'daily personal', token_type: 'bearer' };
  const tokens = await completeFlow(db, config, 'the-code', started.state);
  assert.equal(tokens.access_token, 'at1');
  const sent = calls.at(-1)!.body;
  assert.equal(sent.grant_type, 'authorization_code');
  assert.equal(sent.code, 'the-code');
  assert.equal(sent.client_secret, 'csecret');
  assert.equal(createHash('sha256').update(sent.code_verifier).digest('base64url'), challenge);
  console.log('exchange ok, pkce verifier matches');

  // 4. The state is single-use.
  await assert.rejects(() => completeFlow(db, config, 'the-code', started.state), /Unknown or already-used/);

  // 5. A live token is returned without touching the network.
  const before = calls.length;
  assert.equal(await getAccessToken(db, config), 'at1');
  assert.equal(calls.length, before, 'should not refresh a token that is still valid');

  // 6. An expired token refreshes, and the new single-use refresh token is kept.
  await db.query(`UPDATE oauth_tokens SET expires_at = now() - interval '1 minute' WHERE provider = 'oura'`);
  nextResponse = { access_token: 'at2', refresh_token: 'rt2', expires_in: 86400 };
  assert.equal(await getAccessToken(db, config), 'at2');
  assert.equal(calls.at(-1)!.body.grant_type, 'refresh_token');
  assert.equal(calls.at(-1)!.body.refresh_token, 'rt1');
  assert.equal((await readTokens(db))!.refresh_token, 'rt2');
  console.log('refresh ok, rotated to the new refresh token');

  // 7. A refresh that returns no new refresh token keeps the old one.
  await db.query(`UPDATE oauth_tokens SET expires_at = now() - interval '1 minute' WHERE provider = 'oura'`);
  nextResponse = { access_token: 'at3', expires_in: 86400 };
  assert.equal(await getAccessToken(db, config), 'at3');
  assert.equal((await readTokens(db))!.refresh_token, 'rt2');

  const s = await status(db);
  assert.equal(s.connected, true);
  assert.equal(s.has_refresh_token, true);
  console.log('status:', s);

  console.log('\nOURA OAUTH TEST PASSED');
} finally {
  globalThis.fetch = realFetch;
}
