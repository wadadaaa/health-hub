/**
 * The bot end to end, against an in-memory Postgres with Telegram and the
 * Anthropic API stubbed. The stub plays the part of the model: it is handed
 * the request and answers with whatever blocks the script says, so the tool
 * loop, the history and the commands are all exercised for real.
 *   npx tsx test/telegram.ts
 */
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { loadHistory } from '../src/agent.js';
import { migrate, type Queryable } from '../src/db.js';
import { setTimezone, today } from '../src/dates.js';
import { getSetting, invalidate, setSetting } from '../src/settings.js';
import { handleUpdate } from '../src/telegram.js';
import { listMeals, upsertMetrics, weightTrend } from '../src/service.js';

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
/** Each request to the model consumes one scripted reply. */
let script: { content: unknown[] }[] = [];
const seen: { system: string; messages: any[]; thinking?: unknown; tools?: unknown[] }[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/file/')) return new Response(Buffer.from('jpegbytes'));
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    if (method === 'getFile') return json({ ok: true, result: { file_path: 'photos/x.jpg' } });
    return json({ ok: true, result: {} });
  }
  if (u === 'https://api.anthropic.com/v1/messages') {
    seen.push(JSON.parse(String(init?.body ?? '{}')));
    const next = script.shift();
    assert.ok(next, 'the model was called more times than the script expected');
    return json(next);
  }
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
const toolCall = (name: string, input: unknown, id = 'tu_1') => ({
  content: [
    { type: 'thinking', thinking: 'let me look', signature: 'sig' },
    { type: 'tool_use', id, name, input },
  ],
});

const lastText = () =>
  String([...sent].reverse().find(s => s.method === 'sendMessage')!.body.text);

let seq = 10;
const message = (over: Record<string, unknown>) => ({
  message: { message_id: seq++, chat: { id: 777, type: 'private' }, ...over },
});

const deps = { db, token: TOKEN, anthropicKey: KEY };

try {
  // 1. Nothing is bound yet: a stranger's chatter is ignored.
  await handleUpdate(deps, message({ text: 'привет' }));
  assert.equal(sent.length, 0);
  assert.equal(await getSetting(db, 'telegram_chat_id'), null);

  // 2. /start claims the bot.
  await handleUpdate(deps, message({ text: '/start' }));
  assert.equal(await getSetting(db, 'telegram_chat_id'), '777');
  assert.match(lastText(), /Что умею/);
  console.log('pairing ok');

  // 3. A sentence about food: the model logs it through the tool and answers.
  script = [
    toolCall('log_meal', {
      description: 'Тарелка овсянки с бананом',
      kcal: 420,
      protein_g: 12,
      fat_g: 8,
      carbs_g: 72,
      confidence: 'medium',
    }),
    text('📝 Овсянка с бананом — 420 ккал. 🔥 Осталось 1080.'),
  ];
  await handleUpdate(deps, message({ text: 'тарелка овсянки с бананом' }));
  const meals = await listMeals(db, today());
  assert.equal(meals.length, 1);
  assert.equal(meals[0].kcal, 420);
  assert.equal(meals[0].source, 'telegram');
  assert.match(lastText(), /Овсянка с бананом/);
  assert.equal(script.length, 0, 'the whole script was used');
  console.log('text meal ok');

  // 4. The request itself: thinking on, tools attached, Russian asked for.
  const first = seen[0];
  assert.deepEqual(first.thinking, { type: 'enabled', budget_tokens: 3000 });
  assert.ok((first.tools ?? []).some((t: any) => t.name === 'log_meal'));
  assert.ok((first.tools ?? []).some((t: any) => t.name === 'list_meals'));
  assert.match(first.system, /Answer in Russian/);
  // The tool result went back with the assistant turn intact, thinking included.
  const withResult = seen[1];
  assert.equal(withResult.messages.at(-2).role, 'assistant');
  assert.ok(
    withResult.messages.at(-2).content.some((b: any) => b.type === 'thinking'),
    'thinking blocks survive the round trip',
  );
  assert.equal(withResult.messages.at(-1).content[0].type, 'tool_result');
  console.log('request shape ok');

  // 5. A correction in plain words reaches update_meal, and the history that
  //    makes it possible is there to be read.
  const id = meals[0].id;
  script = [
    toolCall('update_meal', { id, description: 'Овсянка с бананом, без масла', kcal: 360, fat_g: 3 }),
    text('Поправила: 360 ккал.'),
  ];
  await handleUpdate(deps, message({ text: 'там было без масла' }));
  const corrected = await listMeals(db, today());
  assert.equal(corrected.length, 1, 'a correction is not a second meal');
  assert.equal(corrected[0].kcal, 360);
  const sawHistory = seen.at(-2)!.messages;
  assert.ok(
    sawHistory.some((m: any) => JSON.stringify(m.content).includes('овсянки с бананом')),
    'the earlier turn was replayed',
  );
  console.log('correction ok');

  // 6. A photo arrives as an image block; its bytes are not kept in history.
  script = [text('📝 Записала салат — 600 ккал.')];
  await handleUpdate(
    deps,
    message({
      photo: [
        { file_id: 'small', width: 90, height: 90 },
        { file_id: 'big', width: 1280, height: 960 },
      ],
      caption: 'без заправки',
    }),
  );
  assert.equal(sent.find(s => s.method === 'getFile')!.body.file_id, 'big', 'uses the largest rendition');
  const photoTurn = seen.at(-1)!.messages.at(-1);
  assert.equal(photoTurn.content[0].type, 'image');
  assert.equal(photoTurn.content[1].text, 'без заправки');
  const history = await loadHistory(db, '777');
  assert.ok(
    !JSON.stringify(history).includes('jpegbytes'),
    'the photo itself is not stored',
  );
  assert.ok(JSON.stringify(history).includes('[фото еды]'));
  console.log('photo ok');

  // 7. The commands answered without the model at all.
  const modelCalls = seen.length;
  await upsertMetrics(db, today(), 'oura', {
    active_kcal: 500,
    steps: 9100,
    sleep_min: 411,
    readiness: 79,
    workout_min: 35,
  });
  await handleUpdate(deps, message({ text: '/day' }));
  const card = lastText();
  assert.match(card, /1620 \(1500 \+ 120 за активность\)/, 'the activity bonus is spelled out');
  assert.match(card, /актив\. 500 ккал/);
  assert.match(card, /сон 6:51/);
  assert.match(card, /готовность 79/);

  await handleUpdate(deps, message({ text: '/week' }));
  assert.match(lastText(), /9\.1к/);
  assert.match(lastText(), /R79/);

  await handleUpdate(deps, message({ text: 'вес 81,4' }));
  assert.match(lastText(), /81\.4 кг/);
  assert.equal((await weightTrend(db)).latest?.kg, 81.4);

  await handleUpdate(deps, message({ text: '/undo' }));
  assert.equal((await listMeals(db, today())).length, 0);
  assert.match(lastText(), /Удалила/);
  assert.equal(seen.length, modelCalls, 'none of those asked the model');
  console.log('commands ok');

  // 8. /forget drops the conversation and keeps the data.
  await handleUpdate(deps, message({ text: '/forget' }));
  assert.equal((await loadHistory(db, '777')).length, 0);
  assert.equal((await weightTrend(db)).latest?.kg, 81.4, 'weigh-ins survive');
  console.log('forget ok');

  // 9. Guards: no key, no group chats, no other private chat.
  await handleUpdate({ db, token: TOKEN, anthropicKey: null }, message({ text: 'борщ' }));
  assert.match(lastText(), /ключ Anthropic/);

  const before = sent.length;
  await handleUpdate(deps, { message: { message_id: 9, chat: { id: -100, type: 'supergroup' }, text: '/start' } });
  assert.equal(sent.length, before, 'no reply in groups');

  await handleUpdate(deps, { message: { message_id: 8, chat: { id: 555, type: 'private' }, text: 'привет' } });
  assert.match(lastText(), /уже привязан/);
  console.log('guards ok');

  // 10. A model failure is reported, not swallowed, and logs nothing.
  script = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url) === 'https://api.anthropic.com/v1/messages') {
      return new Response('overloaded', { status: 529 });
    }
    return realFetch(url as never, init as never);
  }) as typeof fetch;
  const telegramCalls: typeof sent = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === 'https://api.anthropic.com/v1/messages') return new Response('overloaded', { status: 529 });
    if (u.startsWith('https://api.telegram.org/')) {
      const method = u.split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}'));
      telegramCalls.push({ method, body });
      sent.push({ method, body });
      return json({ ok: true, result: {} });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  await handleUpdate(deps, message({ text: 'борщ' }));
  assert.match(lastText(), /Не получилось/);
  assert.match(lastText(), /529/);
  assert.equal((await listMeals(db, today())).length, 0);
  console.log('failure ok');

  console.log('\nTELEGRAM TEST PASSED');
} finally {
  globalThis.fetch = realFetch;
}
