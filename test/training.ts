/**
 * Sessions, the load they add up to, and the places that refuse to alarm.
 *   npx tsx test/training.ts
 */
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { migrate, type Queryable } from '../src/db.js';
import { setTimezone, shiftDay } from '../src/dates.js';
import { ingestHealthAutoExport } from '../src/ingest/apple.js';
import { deleteWorkout, listWorkouts, logWorkout, trainingLoad, updateWorkout } from '../src/training.js';

setTimezone('Asia/Jerusalem');

const mem = newDb();
const { Pool } = mem.adapters.createPg();
const db = new Pool() as unknown as Queryable;
await migrate(db);

const END = '2026-11-20';
const day = (n: number) => shiftDay(END, -n);
const at = (n: number, hhmm = '07:00') => new Date(`${day(n)}T${hhmm}:00+02:00`);

// --- 1. Nothing logged ---
{
  const l = await trainingLoad(db, END);
  assert.equal(l.verdict, 'нет данных');
  assert.equal(l.ratio, null);
  assert.match(l.notes.join(' '), /не записано/);
  console.log('empty ok');
}

// --- 2. A session, and the effort added afterwards ---
{
  const w = await logWorkout(db, { sport: 'бег', minutes: 40, started_at: at(0), rpe: 6, distance_km: 6.2 });
  assert.equal(w.day, END);
  assert.equal(w.sport, 'бег');
  assert.equal(w.distance_km, 6.2);

  const device = await logWorkout(db, {
    sport: 'swimming',
    minutes: 35,
    started_at: at(1),
    source: 'oura',
    external_id: 'oura-1',
  });
  assert.equal(device.rpe, null, 'a device cannot know how it felt');

  const rated = await updateWorkout(db, device.id, { rpe: 4, note: 'легко, техника' });
  assert.equal(rated!.rpe, 4);

  // A re-sync must not clobber what she said.
  await logWorkout(db, {
    sport: 'swimming',
    minutes: 36,
    started_at: at(1),
    source: 'oura',
    external_id: 'oura-1',
    rpe: null,
  });
  const again = (await listWorkouts(db, 14, END)).find(x => x.id === device.id)!;
  assert.equal(again.rpe, 4, 'the re-sync kept her rating');
  assert.equal(again.minutes, 36, 'but took the corrected duration');
  assert.equal(again.note, 'легко, техника');
  console.log('sessions ok');
}

// --- 3. Early weeks must not be called overload ---
{
  const l = await trainingLoad(db, END);
  assert.equal(l.verdict, 'мало', 'two sessions is not a base to exceed');
  assert.equal(l.ratio, null);
  assert.match(l.notes.join(' '), /скучными/);
  console.log('early ok');
}

// --- 4. A real base, then a spike ---
{
  const spike = newDb();
  const { Pool: P2 } = spike.adapters.createPg();
  const db2 = new P2() as unknown as Queryable;
  await migrate(db2);

  // Four weeks of three steady hours a week.
  for (let n = 27; n >= 7; n--) {
    if (n % 2) continue;
    await logWorkout(db2, { sport: 'бег', minutes: 60, started_at: at(n), rpe: 5 });
  }
  const steady = await trainingLoad(db2, END);
  assert.equal(steady.verdict, 'норма', `ratio ${steady.ratio}`);

  // Then a week three times as big.
  for (let n = 6; n >= 0; n--) {
    await logWorkout(db2, { sport: 'бег', minutes: 90, started_at: at(n), rpe: 8 });
  }
  const spiked = await trainingLoad(db2, END);
  assert.equal(spiked.verdict, 'растёт быстро');
  assert.ok(spiked.ratio! > 1.5, `ratio ${spiked.ratio}`);
  assert.match(spiked.notes.join(' '), /сухожилия/);
  assert.equal(spiked.sessions_7d, 7);
  console.log('spike ok: ratio', spiked.ratio);
}

// --- 5. Missing effort is assumed, and said out loud ---
{
  const quiet = newDb();
  const { Pool: P3 } = quiet.adapters.createPg();
  const db3 = new P3() as unknown as Queryable;
  await migrate(db3);
  await logWorkout(db3, { sport: 'бег', minutes: 60, started_at: at(1), source: 'oura', external_id: 'a' });
  const l = await trainingLoad(db3, END);
  assert.equal(l.assumed_rpe, 1);
  assert.equal(l.acute, 300, '60 minutes at the assumed 5');
  assert.match(l.notes.join(' '), /не указано/);
  console.log('assumed ok');
}

// --- 6. The phone's own sessions land here too ---
{
  const phone = newDb();
  const { Pool: P4 } = phone.adapters.createPg();
  const db4 = new P4() as unknown as Queryable;
  await migrate(db4);

  const result = await ingestHealthAutoExport(db4, {
    data: {
      metrics: [],
      workouts: [
        {
          id: 'hae-1',
          name: 'Running',
          start: `${END} 07:00:00 +0200`,
          end: `${END} 07:42:00 +0200`,
          distance: { qty: 6.8, units: 'km' },
          avgHeartRate: { qty: 152, units: 'bpm' },
          maxHeartRate: { qty: 171, units: 'bpm' },
          activeEnergyBurned: { qty: 410, units: 'kcal' },
        },
      ],
    },
  });
  assert.equal(result.workouts, 1);
  const [w] = await listWorkouts(db4, 7, END);
  assert.equal(w.sport, 'Running');
  assert.equal(w.minutes, 42);
  assert.equal(w.distance_km, 6.8);
  assert.equal(w.avg_hr, 152);
  assert.equal(w.kcal, 410);
  assert.equal(w.source, 'apple');

  // Miles become kilometres.
  await ingestHealthAutoExport(db4, {
    workouts: [
      {
        id: 'hae-2',
        name: 'Walking',
        start: `${day(1)} 18:00:00 +0200`,
        duration: 1800,
        distance: { qty: 2, units: 'mi' },
      },
    ],
  });
  const walk = (await listWorkouts(db4, 7, END)).find(x => x.sport === 'Walking')!;
  assert.equal(walk.distance_km, 3.22);
  assert.equal(walk.minutes, 30);
  console.log('apple ok');
}

// --- 7. Deleting ---
{
  const all = await listWorkouts(db, 14, END);
  assert.equal(await deleteWorkout(db, all[0].id), true);
  assert.equal(await deleteWorkout(db, all[0].id), false);
  console.log('delete ok');
}

console.log('\nTRAINING TEST PASSED');
