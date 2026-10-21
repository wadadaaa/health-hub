/**
 * The measured-expenditure arithmetic and the day-level splits, against an
 * in-memory Postgres. What matters here is not that the numbers are pretty but
 * that the thing refuses to answer when it has no right to.
 *   npx tsx test/energy.ts
 */
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { shiftDay } from '../src/dates.js';
import { migrate, type Queryable } from '../src/db.js';
import { setTimezone } from '../src/dates.js';
import { energyBalance } from '../src/energy.js';
import { insights } from '../src/insights.js';
import { briefingFixture } from './helpers.js';
import { logMeal, logWeight, upsertMetrics } from '../src/service.js';

setTimezone('Asia/Jerusalem');

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const db = new Pool() as unknown as Queryable;
await migrate(db);

const END = '2026-10-28';
const day = (n: number) => shiftDay(END, -n);

// --- 1. Nothing logged: no number, and a reason. ---
{
  const e = await energyBalance(db, 28, END);
  assert.equal(e.tdee, null);
  assert.equal(e.confidence, 'none');
  assert.ok(e.notes.length, 'it says what is missing');
  console.log('empty:', e.notes[0]);
}

// --- 2. A month of honest logging at 1800 kcal, losing 1.4 kg. ---
//        28 days at a true 2185 would cost (2185-1800)*28 = 10780 kcal
//        ≈ 1.4 kg, so the estimate should land near 2185.
for (let n = 27; n >= 0; n--) {
  await logMeal(db, {
    description: `день -${n}`,
    kcal: 1800,
    protein_g: 110,
    fat_g: 55,
    carbs_g: 180,
    eaten_at: new Date(`${day(n)}T13:00:00+03:00`),
    source: 'test',
  });
  // A weigh-in every morning, falling smoothly from 82.0 to 80.6.
  await logWeight(db, Number((82 - (1.4 * (27 - n)) / 27).toFixed(2)), new Date(`${day(n)}T06:00:00+03:00`), 'test');
}

{
  const e = await energyBalance(db, 28, END);
  assert.ok(e.tdee != null, 'with a month of data it answers');
  assert.ok(Math.abs(e.tdee! - 2185) < 120, `tdee ${e.tdee} should be near 2185`);
  assert.equal(e.mean_intake, 1800);
  assert.equal(e.logged_days, 28);
  assert.ok(e.weight.change_kg! < 0, 'weight fell');
  assert.ok(e.weight.rate_kg_week! < 0);
  assert.equal(e.confidence, 'high');
  // For half a kilo a week off that expenditure: 2185 - 550 ≈ 1635.
  assert.ok(Math.abs(e.suggested_budget! - 1635) < 130, `suggested ${e.suggested_budget}`);
  assert.ok(e.notes.some(n => n.includes('выше базы')), 'it compares against the assumed base');
  console.log('measured:', e.tdee, 'suggested:', e.suggested_budget, 'confidence:', e.confidence);
}

// --- 3. Holes in the log disqualify it, rather than skewing it. ---
{
  const gappy = newDb();
  const { Pool: P2 } = gappy.adapters.createPg();
  const db2 = new P2() as unknown as Queryable;
  await migrate(db2);
  for (let n = 27; n >= 0; n -= 3) {
    await logMeal(db2, {
      description: 'редкая запись',
      kcal: 1800,
      eaten_at: new Date(`${day(n)}T13:00:00+03:00`),
      source: 'test',
    });
  }
  await logWeight(db2, 82, new Date(`${day(27)}T06:00:00+03:00`), 'test');
  await logWeight(db2, 80.6, new Date(`${day(0)}T06:00:00+03:00`), 'test');
  const e = await energyBalance(db2, 28, END);
  assert.equal(e.tdee, null, 'a third of the days logged is not evidence');
  assert.ok(e.notes.some(n => n.includes('из')), e.notes.join(' | '));
  console.log('gappy:', e.notes[0]);
}

// --- 4. Splits: silent until both groups are big enough. ---
{
  const i = await insights(db, 28, END);
  const sleepSplit = i.splits.find(s => s.question.includes('короткого сна'))!;
  assert.equal(sleepSplit.reportable, false, 'no metrics yet, so nothing to report');
  assert.ok(i.notes.some(n => n.includes('не причина')), 'it refuses to claim causation');
}

// Give half the days a short night and more food, the other half the reverse.
for (let n = 27; n >= 0; n--) {
  const short = n % 2 === 0;
  await upsertMetrics(db, day(n), 'oura', {
    sleep_min: short ? 340 : 440,
    readiness: short ? 70 : 85,
    workout_min: short ? 0 : 45,
    steps: 8000,
  });
}
{
  const i = await insights(db, 28, END);
  const sleepSplit = i.splits.find(s => s.question.includes('короткого сна'))!;
  assert.equal(sleepSplit.reportable, true);
  assert.equal(sleepSplit.n_when, 14);
  assert.equal(sleepSplit.n_otherwise, 14);
  // Intake was flat at 1800, so the honest answer is "no difference".
  assert.equal(sleepSplit.difference, 0, 'a flat diet shows no difference');

  const trainSplit = i.splits.find(s => s.question.includes('тренировкой') && s.unit === 'ккал')!;
  assert.equal(trainSplit.reportable, true);
  assert.equal(trainSplit.n_when, 14);
  console.log('splits ok:', i.splits.filter(s => s.reportable).length, 'reportable');
}

// --- 5. The briefing renders from whatever is there, without a model. ---
{
  const text = await briefingFixture(db, END);
  assert.match(text, /☀️/);
  assert.match(text, /Сегодня/);
  assert.match(text, /кг в среднем за 7 дней/);
  assert.match(text, /Измеренный расход/);
  assert.ok(!text.includes('undefined') && !text.includes('NaN'), text);
  console.log('briefing ok');
}

console.log('\nENERGY TEST PASSED');
