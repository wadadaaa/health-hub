/**
 * Startup retry behaviour and what /healthz says while the database is down.
 *   npx tsx test/readiness.ts
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { newDb } from 'pg-mem';
import { setTimezone } from '../src/dates.js';
import { createApp } from '../src/http.js';
import type { Queryable } from '../src/db.js';
import { createReadiness, keepTrying } from '../src/readiness.js';

setTimezone('Asia/Jerusalem');

// 1. keepTrying retries, records the failure, and resolves once the work does.
{
  const state = createReadiness();
  const slept: number[] = [];
  let calls = 0;
  await keepTrying(
    state,
    async () => {
      calls += 1;
      if (calls < 4) throw new Error(`ECONNREFUSED attempt ${calls}`);
      return ['001_init.sql'];
    },
    { minDelayMs: 10, maxDelayMs: 40 },
    async ms => {
      slept.push(ms);
    },
  );
  assert.equal(calls, 4);
  assert.equal(state.phase, 'ready');
  assert.equal(state.attempts, 4);
  assert.equal(state.lastError, null);
  assert.deepEqual(state.migrations, ['001_init.sql']);
  assert.deepEqual(slept, [10, 20, 40], 'backs off, then caps');
  console.log('keepTrying retries and backs off ok');
}

// 2. While the database is down, /healthz is 503 and says why; data routes 503 too.
{
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Queryable;
  const readiness = createReadiness();
  readiness.phase = 'failing';
  readiness.attempts = 3;
  readiness.lastError = 'connect ECONNREFUSED 10.0.0.2:5432';

  const config = {
    MCP_PATH_SECRET: 'test-secret-path-123456789012345678',
    API_TOKEN: 'test-api-token-1234567890123456789',
  };
  const app = createApp({ db, config, oura: { oauth: null, tokenSource: null }, readiness });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 503);
    const body = await health.json();
    assert.equal(body.ok, false);
    assert.equal(body.phase, 'failing');
    assert.equal(body.attempts, 3);
    assert.match(body.error, /ECONNREFUSED/);
    console.log('healthz while down:', body);

    const api = await fetch(`${base}/api/day`, { headers: { authorization: `Bearer ${config.API_TOKEN}` } });
    assert.equal(api.status, 503);

    const mcp = await fetch(`${base}/mcp/${config.MCP_PATH_SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(mcp.status, 503);
    console.log('data routes answer 503 while starting');

    // 3. Once ready, the same endpoints work.
    readiness.phase = 'ready';
    readiness.migrations = ['001_init.sql', '002_oura_oauth.sql'];
    const ok = await fetch(`${base}/healthz`);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).migrations, ['001_init.sql', '002_oura_oauth.sql']);
    console.log('healthz when ready ok');
  } finally {
    server.close();
  }
}

console.log('\nREADINESS TEST PASSED');
