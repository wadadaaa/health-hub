/**
 * Cycle day, phase, and the places the phase changes how other numbers read.
 *   npx tsx test/cycle.ts
 */
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { cycleStatus, listCycles, logPeriodStart, phasesByDay } from '../src/cycle.js';
import { migrate, type Queryable } from '../src/db.js';
import { setTimezone, shiftDay } from '../src/dates.js';
import { upsertMetrics } from '../src/service.js';

setTimezone('Asia/Jerusalem');

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const db = new Pool() as unknown as Queryable;
await migrate(db);

// --- nothing logged ---
{
  const s = await cycleStatus(db, '2026-10-22');
  assert.equal(s.cycle_day, null);
  assert.equal(s.phase, 'неизвестно');
  assert.equal(s.confidence, 'none');
  assert.match(s.notes[0], /первый день цикла/i);
  console.log('empty ok');
}

// --- one start: a phase, but an assumed length ---
{
  await logPeriodStart(db, '2026-10-16');
  const s = await cycleStatus(db, '2026-10-22');
  assert.equal(s.cycle_day, 7, 'day 1 is the first day of bleeding');
  assert.equal(s.phase, 'фолликулярная');
  assert.equal(s.confidence, 'assumed');
  assert.equal(s.length_used, 28);
  assert.equal(s.predicted_next_start, '2026-11-13');
  assert.match(s.notes.join(' '), /28 дн/);
  console.log('one start ok: день', s.cycle_day, s.phase);
}

// --- a history: her own length, and the phases that follow from it ---
{
  // Four cycles of 30, 30, 30 days ending at 2026-10-16.
  for (const d of ['2026-07-18', '2026-08-17', '2026-09-16']) await logPeriodStart(db, d);
  const cycles = await listCycles(db);
  assert.equal(cycles[0].day, '2026-10-16');
  assert.equal(cycles[0].length, 30, 'the length of the cycle this start began');

  const s = await cycleStatus(db, '2026-10-22');
  assert.equal(s.confidence, 'measured');
  assert.equal(s.mean_length, 30);
  assert.equal(s.observed_cycles, 3);
  assert.equal(s.predicted_next_start, '2026-11-15');

  // With a 30-day cycle, ovulation sits at day 16.
  assert.equal((await cycleStatus(db, '2026-10-17')).phase, 'менструальная'); // day 2
  assert.equal((await cycleStatus(db, '2026-10-25')).phase, 'фолликулярная'); // day 10
  assert.equal((await cycleStatus(db, '2026-10-31')).phase, 'овуляторная'); // day 16
  assert.equal((await cycleStatus(db, '2026-11-08')).phase, 'лютеиновая'); // day 24
  console.log('measured ok: длина', s.mean_length, 'овуляция ~день 16');
}

// --- the luteal warning is the point of the whole file ---
{
  const s = await cycleStatus(db, '2026-11-08');
  assert.ok(s.notes.some(n => /1–2 кг/.test(n)), 'it warns about water before the scale misleads');
  console.log('luteal note ok');
}

// --- a start so old it is a gap, not a cycle ---
{
  const s = await cycleStatus(db, '2027-02-01');
  assert.equal(s.phase, 'неизвестно');
  assert.equal(s.cycle_day, null);
  assert.match(s.notes.join(' '), /пропущено/);
  console.log('stale ok');
}

// --- temperature: unusual for the phase, so it says so ---
{
  await upsertMetrics(db, '2026-10-25', 'oura', { temp_deviation: 0.4, readiness: 70 });
  const s = await cycleStatus(db, '2026-10-25');
  assert.equal(s.temp_deviation, 0.4);
  assert.ok(s.notes.some(n => /необычно/.test(n)));
  console.log('temperature ok');
}

// --- phases across a range, for reading other series through ---
{
  const map = await phasesByDay(db, '2026-10-10', '2026-10-20');
  assert.equal(map.get('2026-10-10'), 'лютеиновая', 'the tail of the previous cycle');
  assert.equal(map.get('2026-10-16'), 'менструальная');
  assert.equal(map.get('2026-10-20'), 'менструальная', 'day 5 is still the period');
  const later = await phasesByDay(db, '2026-10-21', '2026-10-22');
  assert.equal(later.get('2026-10-22'), 'фолликулярная', 'day 7 is not');

  const before = await phasesByDay(db, '2026-07-01', '2026-07-05');
  assert.equal(before.get('2026-07-03'), 'неизвестно', 'nothing is guessed before the first logged start');
  console.log('phases ok');
}

console.log('\nCYCLE TEST PASSED');
