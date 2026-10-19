/**
 * Smoke test against an in-memory Postgres (pg-mem). No Docker needed:
 *   npm run test:smoke
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { newDb } from 'pg-mem';
import { migrate, type Queryable } from '../src/db.js';
import { setTimezone, today } from '../src/dates.js';
import { createApp } from '../src/http.js';

setTimezone('Asia/Jerusalem');

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const db = new Pool() as unknown as Queryable;

const ran = await migrate(db);
console.log('migrations:', ran);

const config = {
  MCP_PATH_SECRET: 'test-secret-path-123456789012345678',
  API_TOKEN: 'test-api-token-1234567890123456789',
  OURA_TOKEN: undefined,
};
const app = createApp({ db, config });
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown> = {}, path = `/mcp/${config.MCP_PATH_SECRET}`, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.equal(r.status, 200, `tools/call ${name} -> ${r.status}: ${JSON.stringify(r.body)}`);
  assert.ok(!r.body.error, `tools/call ${name} error: ${JSON.stringify(r.body.error)}`);
  const result = r.body.result;
  assert.ok(!result.isError, `tool ${name} returned isError: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
};

try {
  // 1. MCP handshake
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  assert.equal(init.body.result.serverInfo.name, 'health-hub');
  console.log('initialize ok, protocol', init.body.result.protocolVersion);

  const list = await rpc('tools/list');
  const names = list.body.result.tools.map((t: { name: string }) => t.name).sort();
  console.log('tools:', names.join(', '));
  assert.deepEqual(names, [
    'delete_meal', 'get_day', 'get_targets', 'get_week', 'log_meal', 'log_weight',
    'set_targets', 'sync_oura', 'update_meal', 'weight_trend',
  ]);

  // 2. Auth: wrong secret -> 404, bearer on /mcp -> ok
  const bad = await rpc('tools/list', {}, '/mcp/nope');
  assert.equal(bad.status, 404);
  const viaBearer = await rpc('tools/list', {}, '/mcp', { authorization: `Bearer ${config.API_TOKEN}` });
  assert.equal(viaBearer.status, 200);
  const noAuth = await fetch(`${base}/api/day`);
  assert.equal(noAuth.status, 401);
  console.log('auth ok');

  // 3. Log today's meals (the salad from the conversation)
  const m1 = await call('log_meal', {
    description: 'Tuna Caesar salad with pasta, chickpeas, veg + 2 slices wholegrain bread',
    kcal: 750, protein_g: 46, fat_g: 28, carbs_g: 80, confidence: 'medium',
  });
  assert.equal(m1.meal.day, today());
  const m2 = await call('log_meal', { description: 'Large coffee with milk', kcal: 120, protein_g: 6, fat_g: 6, carbs_g: 10 });
  assert.equal(m2.remaining.kcal, 1500 - 870);
  console.log('log_meal ok; remaining', m2.remaining);

  // 4. Health Auto Export webhook (kJ units + workout) -> adjusted budget
  const d = today();
  const hae = await fetch(`${base}/webhook/health-auto-export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.API_TOKEN}` },
    body: JSON.stringify({
      data: {
        metrics: [
          { name: 'active_energy', units: 'kJ', data: [
            { date: `${d} 08:00:00 +0300`, qty: 1255.2 }, // 300 kcal
            { date: `${d} 18:00:00 +0300`, qty: 1673.6 }, // 400 kcal
          ] },
          { name: 'step_count', units: 'count', data: [{ date: `${d} 12:00:00 +0300`, qty: 9100 }] },
          { name: 'resting_heart_rate', units: 'count/min', data: [{ date: `${d} 00:00:00 +0300`, qty: 54 }] },
          { name: 'sleep_analysis', units: 'hr', data: [{ date: `${d} 07:10:00 +0300`, asleep: 6.8, inBed: 7.5 }] },
          { name: 'weight_body_mass', units: 'kg', data: [{ date: `${d} 07:30:00 +0300`, qty: 82.0 }] },
          { name: 'walking_speed', units: 'km/hr', data: [{ date: `${d} 12:00:00 +0300`, qty: 5.1 }] },
        ],
        workouts: [{ name: 'Running', start: `${d} 06:30:00 +0300`, end: `${d} 07:05:00 +0300`, duration: 2100 }],
      },
    }),
  });
  const haeBody = await hae.json();
  assert.equal(hae.status, 200, JSON.stringify(haeBody));
  assert.deepEqual(haeBody.days, [d]);
  assert.deepEqual(haeBody.unknown, ['walking_speed']);
  console.log('health-auto-export ok:', haeBody);

  const day = await call('get_day', {});
  assert.equal(day.metrics.active_kcal, 700);
  assert.equal(day.metrics.steps, 9100);
  assert.equal(day.metrics.sleep_min, 408);
  assert.equal(day.metrics.workout_min, 35);
  assert.equal(day.budget.day_type, 'training');
  assert.equal(day.budget.extra, 240); // 0.6 * (700 - 300)
  assert.equal(day.budget.adjusted, 1740);
  assert.equal(day.remaining.kcal, 1740 - 870);
  assert.equal(day.weight.kg, 82);
  console.log('get_day ok:', { budget: day.budget, remaining: day.remaining, weight: day.weight });

  // 5. Correct a meal, delete one
  const upd = await call('update_meal', { id: m2.meal.id, kcal: 150, description: 'Large cappuccino, 3% milk' });
  assert.equal(upd.meal.kcal, 150);
  const del = await call('delete_meal', { id: upd.meal.id });
  assert.equal(del.deleted, true);
  const after = await call('get_day', {});
  assert.equal(after.consumed.kcal, 750);
  console.log('update/delete ok');

  // 6. Shortcut webhook with manual override + targets versioning + week
  const sc = await fetch(`${base}/webhook/shortcut`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.API_TOKEN}` },
    body: JSON.stringify({ source: 'manual', readiness: 81 }),
  });
  assert.equal(sc.status, 200);
  const t = await call('set_targets', { kcal: 1550, protein_g: 125, fat_g: 50, carbs_g: 150, note: 'smoke' });
  assert.equal(t.active_factor, 0.6);
  const week = await call('get_week', {});
  assert.equal(week.days.length, 7);
  assert.equal(week.days[6].readiness, 81);
  assert.equal(week.days[6].budget, 1550 + 240);
  assert.equal(week.weight.latest.kg, 82);
  console.log('week ok:', { logged_days: week.logged_days, avg_delta: week.avg_delta, weight: week.weight.latest });

  // 7. REST API
  const apiDay = await fetch(`${base}/api/day`, { headers: { authorization: `Bearer ${config.API_TOKEN}` } });
  assert.equal(apiDay.status, 200);
  const posted = await fetch(`${base}/api/meals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.API_TOKEN}` },
    body: JSON.stringify({ description: 'Greek yogurt 200g', kcal: 130, protein_g: 20, source: 'telegram' }),
  });
  assert.equal(posted.status, 201);
  console.log('rest api ok');

  console.log('\nSMOKE TEST PASSED');
} finally {
  server.close();
}
