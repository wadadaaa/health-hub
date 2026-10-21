/**
 * The bot's routing, against an in-memory Postgres with Telegram and the
 * Anthropic API stubbed.
 *   npx tsx test/telegram.ts
 */
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { migrate, type Queryable } from '../src/db.js';
import { setTimezone } from '../src/dates.js';
import { getSetting, invalidate, setSetting } from '../src/settings.js';
import { handleUpdate } from '../src/telegram.js';
import { listMeals, upsertMetrics, weightTrend } from '../src/service.js';
import { today } from '../src/dates.js';

setTimezone('Asia/Jerusalem');

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const db = new Pool() as unknown as Queryable;
await migrate(db);
invalidate();

const TOKEN = 'bot-token';
const KEY = 'anthropic-key';

// --- stub the two outside services ---
const sent: { method: string; body: Record<string, unknown> }[] = [];
let estimate = { description: 'Овсянка с бананом', kcal: 420, protein_g: 12, fat_g: 8, carbs_g: 72, confidence: 'medium' as const };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    if (method === 'getFile') return json({ ok: true, result: { file_path: 'photos/x.jpg' } });
    return json({ ok: true, result: {} });
  }
  if (u.startsWith('https://api.telegram.org/file/')) return new Response(Buffer.from('jpegbytes'));
  if (u === 'https://api.anthropic.com/v1/messages') {
    return json({ content: [{ type: 'tool_use', name: 'log_meal', input: estimate }] });
  }
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;
function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
const deps = { db, token: TOKEN, anthropicKey: KEY };
const lastText = () => String(sent.filter(s => s.method === 'sendMessage').at(-1)!.body.text);
const message = (over: Record<string, unknown>) => ({
  message: { message_id: 1, chat: { id: 777, type: 'private' }, ...over },
});

try {
  // 1. The first /start binds the chat.
  await handleUpdate(deps, message({ text: '/start' }));
  assert.equal(await getSetting(db, 'telegram_chat_id'), '777');
  assert.match(lastText(), /привязан/i);

  // 2. Another chat is refused, and binding does not move.
  await handleUpdate(deps, { message: { message_id: 2, chat: { id: 999, type: 'private' }, text: '/start' } });
  assert.match(lastText(), /личный/i);
  assert.equal(await getSetting(db, 'telegram_chat_id'), '777');
  console.log('pairing ok');

  // 3. Text about food is estimated, logged, and answered with the remainder.
  await handleUpdate(deps, message({ text: 'тарелка овсянки с бананом' }));
  const meals = await listMeals(db, today());
  assert.equal(meals.length, 1);
  assert.equal(meals[0].kcal, 420);
  assert.equal(meals[0].source, 'telegram');
  assert.match(lastText(), /Овсянка с бананом/);
  assert.match(lastText(), /Осталось 1080 ккал/);
  console.log('text meal ok:', lastText().split('\n')[1]);

  // 4. A photo goes through getFile, the download and the vision call.
  estimate = { description: 'Салат с тунцом', kcal: 600, protein_g: 40, fat_g: 25, carbs_g: 50, confidence: 'low' };
  await handleUpdate(deps, message({ photo: [{ file_id: 'small', width: 90, height: 90 }, { file_id: 'big', width: 1280, height: 960 }] }));
  assert.equal(sent.find(s => s.method === 'getFile')!.body.file_id, 'big', 'uses the largest rendition');
  assert.equal((await listMeals(db, today())).length, 2);
  assert.match(lastText(), /Оценка грубая/);
  assert.match(lastText(), /Осталось 480 ккал/);
  console.log('photo meal ok');

  // 5. Asking in words, and the weight shorthand.
  await handleUpdate(deps, message({ text: 'сколько осталось?' }));
  assert.match(lastText(), /Осталось 480 ккал/);
  assert.equal((await listMeals(db, today())).length, 2, 'a question must not log a meal');

  await handleUpdate(deps, message({ text: 'вес 81,4' }));
  assert.match(lastText(), /81\.4 кг/);
  assert.equal((await weightTrend(db)).latest?.kg, 81.4);
  console.log('query and weight ok');

  // 6. /undo removes the last meal.
  await handleUpdate(deps, message({ text: '/undo' }));
  assert.equal((await listMeals(db, today())).length, 1);
  assert.match(lastText(), /Удалила: Салат с тунцом/);
  console.log('undo ok');

  // 7. Without an Anthropic key, food goes unestimated rather than mis-logged.
  await handleUpdate({ db, token: TOKEN, anthropicKey: null }, message({ text: 'борщ' }));
  assert.match(lastText(), /ключ Anthropic/);
  assert.equal((await listMeals(db, today())).length, 1);

  // 8. A group chat is ignored outright.
  const before = sent.length;
  await handleUpdate(deps, { message: { message_id: 9, chat: { id: -100, type: 'supergroup' }, text: '/start' } });
  assert.equal(sent.length, before, 'no reply in groups');
  console.log('guards ok');

  // 9. Oura's numbers reach the reply: they raise the budget, and the day
  //    line says what they were, so the figure is not out of nowhere.
  await upsertMetrics(db, today(), 'oura', {
    active_kcal: 500,
    steps: 9100,
    sleep_min: 411,
    readiness: 79,
    workout_min: 35,
  });
  await handleUpdate(deps, message({ text: '/day' }));
  const withRing = lastText();
  assert.match(withRing, /1620 \(1500 \+ 120 за активность\)/, 'budget shows the activity bonus');
  assert.match(withRing, /актив\. 500 ккал/);
  assert.match(withRing, /9100 шагов/);
  assert.match(withRing, /трен\. 35 мин/);
  assert.match(withRing, /сон 6:51/);
  assert.match(withRing, /готовность 79/);

  await handleUpdate(deps, message({ text: '/week' }));
  assert.match(lastText(), /9\.1к/, 'the week shows steps');
  assert.match(lastText(), /R79/, 'the week shows readiness');
  console.log('oura metrics ok');

  console.log('\nTELEGRAM TEST PASSED');
} finally {
  globalThis.fetch = realFetch;
}
