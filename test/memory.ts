/**
 * Facts, the food dictionary and the correction log.
 *   npx tsx test/memory.ts
 */
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { migrate, type Queryable } from '../src/db.js';
import { setTimezone, shiftDay } from '../src/dates.js';
import {
  calibration,
  categorise,
  forget,
  learnedPrompt,
  listFacts,
  recallMeals,
  remember,
} from '../src/memory.js';
import { logMeal, updateMeal } from '../src/service.js';

setTimezone('Asia/Jerusalem');

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const db = new Pool() as unknown as Queryable;
await migrate(db);

const END = '2026-10-28';
const day = (n: number) => shiftDay(END, -n);

// --- facts ---
{
  assert.deepEqual(await listFacts(db), []);
  await remember(db, 'обед по будням', 'Shaya рядом с офисом, обычно тунцовый цезарь');
  await remember(db, 'не ест', 'лобстер — аллергия');
  let facts = await listFacts(db);
  assert.equal(facts.length, 2);

  await remember(db, 'не ест', 'лобстер и креветки — аллергия');
  facts = await listFacts(db);
  assert.equal(facts.length, 2, 'the same key is replaced, not duplicated');
  assert.match(facts.find(f => f.key === 'не ест')!.value, /креветки/);

  assert.equal(await forget(db, 'не ест'), true);
  assert.equal(await forget(db, 'не ест'), false, 'forgetting twice is not an error');
  assert.equal((await listFacts(db)).length, 1);

  await assert.rejects(() => remember(db, '   ', 'что-то'), /key and a value/);
  console.log('facts ok');
}

// --- the food dictionary ---
{
  const eaten = [
    ['Тунцовый цезарь из Shaya с пастой и нутом', 750],
    ['Тунцовый цезарь из Shaya, без хлеба', 590],
    ['Тунцовый цезарь из Shaya', 700],
    ['Овсянка с бананом и арахисовой пастой', 480],
    ['Круассан с ванильным кремом', 750],
  ] as const;
  for (let i = 0; i < eaten.length; i++) {
    await logMeal(db, {
      description: eaten[i][0],
      kcal: eaten[i][1],
      protein_g: 30,
      fat_g: 25,
      carbs_g: 60,
      eaten_at: new Date(`${day(i + 1)}T13:00:00+03:00`),
      source: 'test',
    });
  }

  const hits = await recallMeals(db, 'тунцовый цезарь', 5, 180, END);
  assert.ok(hits.length >= 1, 'it finds the dish');
  assert.match(hits[0].description, /цезарь/i);
  assert.ok(hits[0].score > 0.3, `score ${hits[0].score}`);
  assert.ok(
    hits.every(h => !/Круассан/.test(h.description)),
    'an unrelated dish does not come back',
  );

  // Repeats collapse rather than filling the answer.
  const same = hits.filter(h => /цезарь/i.test(h.description));
  assert.ok(same.length <= 3, 'near-identical descriptions are grouped');

  assert.deepEqual(await recallMeals(db, 'и с на', 5, 180, END), [], 'stop words alone match nothing');
  console.log('recall ok:', hits.map(h => `${h.description.slice(0, 28)} ${h.kcal}`).join(' | '));
}

// --- categories ---
{
  assert.equal(categorise('Круассан с кремом'), 'выпечка и десерты');
  assert.equal(categorise('Тунцовый цезарь'), 'салаты');
  assert.equal(categorise('Куриная грудка на гриле'), 'мясо и рыба');
  assert.equal(categorise('Латте на овсяном'), 'напитки');
  assert.equal(categorise('Нечто неопознанное'), 'прочее');
  console.log('categories ok');
}

// --- the correction log ---
{
  // Ten pastries, each corrected upward by half.
  for (let i = 0; i < 10; i++) {
    const meal = await logMeal(db, {
      description: `Круассан с кремом #${i}`,
      kcal: 500,
      protein_g: 8,
      fat_g: 25,
      carbs_g: 55,
      eaten_at: new Date(`${day(i + 1)}T10:00:00+03:00`),
      source: 'test',
    });
    await updateMeal(db, meal.id, { kcal: 750 });
  }
  // One salad corrected slightly: not enough to be a pattern.
  const salad = await logMeal(db, {
    description: 'Салат с тунцом',
    kcal: 600,
    eaten_at: new Date(`${day(2)}T13:30:00+03:00`),
    source: 'test',
  });
  await updateMeal(db, salad.id, { kcal: 620 });

  const cal = await calibration(db);
  const pastry = cal.categories.find(c => c.category === 'выпечка и десерты')!;
  assert.equal(pastry.n, 10);
  assert.equal(pastry.median_ratio, 1.5);
  assert.equal(pastry.median_kcal_delta, 250);
  assert.equal(pastry.reportable, true);

  const salads = cal.categories.find(c => c.category === 'салаты')!;
  assert.equal(salads.n, 1);
  assert.equal(salads.reportable, false, 'one correction is not a pattern');

  // A rename with the same calories is not a correction of the estimate.
  const before = (await calibration(db)).total;
  await updateMeal(db, salad.id, { description: 'Салат с тунцом из Shaya' });
  assert.equal((await calibration(db)).total, before, 'a reword is not logged');
  console.log('corrections ok: ×' + pastry.median_ratio, 'on', pastry.n);
}

// --- what reaches the prompt ---
{
  const p = await learnedPrompt(db);
  assert.match(p, /обед по будням/, 'facts reach the prompt');
  assert.match(p, /выпечка и десерты/, 'a measured bias reaches the prompt');
  assert.match(p, /×1\.5/);
  assert.ok(!p.includes('салаты'), 'an unreportable category stays out');

  const empty = newDb();
  const { Pool: P2 } = empty.adapters.createPg();
  const db2 = new P2() as unknown as Queryable;
  await migrate(db2);
  assert.equal(await learnedPrompt(db2), '', 'nothing learned yet means nothing added');
  console.log('prompt ok');
}

console.log('\nMEMORY TEST PASSED');
