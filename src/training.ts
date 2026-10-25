/**
 * Training sessions and the load they add up to.
 *
 * The number that matters here is not distance or pace but session RPE ×
 * minutes — Foster's method, the oldest and most robust way to put a swim, a
 * run and an hour of lifting on the same scale. It needs one input no watch
 * can supply: how hard it felt. So the bot asks, and a session without an
 * answer is counted at a conservative default rather than dropped.
 *
 * Acute load is the last 7 days, chronic the last 28 as a weekly average, and
 * their ratio is the usual rough guard against adding too much too fast. The
 * ratio is a blunt instrument with a contested evidence base; it is here as a
 * brake on obvious mistakes — the ex-athlete returning after months off who
 * remembers an older body — not as a number to optimise.
 */
import type { Queryable } from './db.js';
import { dbDay, dbInstant, localDay, shiftDay, today } from './dates.js';

/** What a session is assumed to have cost when she never said. */
const DEFAULT_RPE = 5;

export interface Workout {
  id: number;
  day: string;
  started_at: string;
  sport: string;
  minutes: number;
  distance_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  kcal: number | null;
  rpe: number | null;
  note: string | null;
  source: string;
}

export interface LogWorkoutInput {
  sport: string;
  minutes: number;
  started_at?: Date;
  distance_km?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  kcal?: number | null;
  rpe?: number | null;
  note?: string | null;
  source?: string;
  external_id?: string | null;
}

const COLS =
  'id, day, started_at, sport, minutes, distance_km, avg_hr, max_hr, kcal, rpe, note, source';

const num = (v: unknown): number | null => (v == null ? null : Number(v));

function toWorkout(r: Record<string, unknown>): Workout {
  return {
    id: Number(r.id),
    day: dbDay(r.day),
    started_at: dbInstant(r.started_at),
    sport: String(r.sport),
    minutes: Number(r.minutes),
    distance_km: num(r.distance_km),
    avg_hr: num(r.avg_hr),
    max_hr: num(r.max_hr),
    kcal: num(r.kcal),
    rpe: num(r.rpe),
    note: r.note == null ? null : String(r.note),
    source: String(r.source),
  };
}

export async function logWorkout(db: Queryable, input: LogWorkoutInput): Promise<Workout> {
  const started = input.started_at ?? new Date();
  const day = localDay(started);
  const { rows } = await db.query(
    `INSERT INTO workouts (day, started_at, sport, minutes, distance_km, avg_hr, max_hr, kcal, rpe, note, source, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (source, external_id) DO UPDATE SET
       minutes     = EXCLUDED.minutes,
       distance_km = COALESCE(EXCLUDED.distance_km, workouts.distance_km),
       avg_hr      = COALESCE(EXCLUDED.avg_hr,      workouts.avg_hr),
       max_hr      = COALESCE(EXCLUDED.max_hr,      workouts.max_hr),
       kcal        = COALESCE(EXCLUDED.kcal,        workouts.kcal),
       -- Never let a re-sync overwrite how it felt: the device does not know.
       rpe         = COALESCE(workouts.rpe,         EXCLUDED.rpe),
       note        = COALESCE(workouts.note,        EXCLUDED.note)
     RETURNING ${COLS}`,
    [
      day,
      started.toISOString(),
      input.sport.trim().slice(0, 60),
      Math.round(input.minutes),
      input.distance_km ?? null,
      input.avg_hr ?? null,
      input.max_hr ?? null,
      input.kcal ?? null,
      input.rpe ?? null,
      input.note?.slice(0, 500) ?? null,
      input.source ?? 'manual',
      input.external_id ?? null,
    ],
  );
  return toWorkout(rows[0]);
}

export async function updateWorkout(
  db: Queryable,
  id: number,
  patch: Partial<Pick<LogWorkoutInput, 'sport' | 'minutes' | 'distance_km' | 'avg_hr' | 'rpe' | 'note'>>,
): Promise<Workout | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.sport !== undefined) push('sport', patch.sport);
  if (patch.minutes !== undefined) push('minutes', Math.round(patch.minutes));
  if (patch.distance_km !== undefined) push('distance_km', patch.distance_km);
  if (patch.avg_hr !== undefined) push('avg_hr', patch.avg_hr);
  if (patch.rpe !== undefined) push('rpe', patch.rpe);
  if (patch.note !== undefined) push('note', patch.note);
  if (!sets.length) return getWorkout(db, id);
  params.push(id);
  const { rows } = await db.query(
    `UPDATE workouts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLS}`,
    params,
  );
  return rows[0] ? toWorkout(rows[0]) : null;
}

export async function getWorkout(db: Queryable, id: number): Promise<Workout | null> {
  const { rows } = await db.query(`SELECT ${COLS} FROM workouts WHERE id = $1`, [id]);
  return rows[0] ? toWorkout(rows[0]) : null;
}

export async function deleteWorkout(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM workouts WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function listWorkouts(db: Queryable, days = 14, endDay: string = today()): Promise<Workout[]> {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM workouts WHERE day >= $1 AND day <= $2 ORDER BY started_at DESC`,
    [shiftDay(endDay, -(days - 1)), endDay],
  );
  return rows.map(toWorkout);
}

// ---------- load ----------

export interface TrainingLoad {
  window: { start: string; end: string };
  /** Session RPE × minutes, summed over the last 7 days. */
  acute: number;
  /** The same, averaged per week over the last 28. */
  chronic: number;
  /** acute / chronic. Null until there is a chronic baseline to divide by. */
  ratio: number | null;
  sessions_7d: number;
  minutes_7d: number;
  sessions_28d: number;
  /** How many of the last 7 days' sessions had no RPE and were assumed. */
  assumed_rpe: number;
  by_sport: { sport: string; sessions: number; minutes: number }[];
  verdict: 'нет данных' | 'мало' | 'норма' | 'растёт быстро';
  notes: string[];
}

export async function trainingLoad(db: Queryable, endDay: string = today()): Promise<TrainingLoad> {
  const start28 = shiftDay(endDay, -27);
  const start7 = shiftDay(endDay, -6);
  const all = await listWorkouts(db, 28, endDay);

  const score = (w: Workout) => (w.rpe ?? DEFAULT_RPE) * w.minutes;
  const last7 = all.filter(w => w.day >= start7);
  const acute = Math.round(last7.reduce((a, w) => a + score(w), 0));
  const chronic = Math.round(all.reduce((a, w) => a + score(w), 0) / 4);

  const bySport = new Map<string, { sessions: number; minutes: number }>();
  for (const w of last7) {
    const g = bySport.get(w.sport) ?? { sessions: 0, minutes: 0 };
    g.sessions += 1;
    g.minutes += w.minutes;
    bySport.set(w.sport, g);
  }

  const notes: string[] = [];
  const assumed = last7.filter(w => w.rpe == null).length;
  if (assumed) {
    notes.push(
      `У ${assumed} из ${last7.length} сессий не указано, насколько было тяжело — взято ${DEFAULT_RPE} из 10. ` +
        'Скажи боту, как прошло, и нагрузка посчитается честнее.',
    );
  }

  let ratio: number | null = null;
  let verdict: TrainingLoad['verdict'] = 'нет данных';

  if (!all.length) {
    notes.push('Тренировок за месяц не записано.');
  } else if (chronic < 100) {
    verdict = 'мало';
    notes.push(
      'Базы ещё нет: месячный фон слишком мал, чтобы говорить о перегрузе. Первые недели и должны быть скучными.',
    );
  } else {
    ratio = Math.round((acute / chronic) * 100) / 100;
    if (ratio > 1.5) {
      verdict = 'растёт быстро';
      notes.push(
        `Неделя тяжелее месячного фона в ${ratio} раза. После долгого перерыва рвутся не мышцы, а сухожилия, ` +
          'и рвутся именно на таком скачке. Добавляй не больше 10% объёма в неделю.',
      );
    } else {
      verdict = 'норма';
    }
  }

  return {
    window: { start: start28, end: endDay },
    acute,
    chronic,
    ratio,
    sessions_7d: last7.length,
    minutes_7d: Math.round(last7.reduce((a, w) => a + w.minutes, 0)),
    sessions_28d: all.length,
    assumed_rpe: assumed,
    by_sport: [...bySport.entries()]
      .map(([sport, g]) => ({ sport, sessions: g.sessions, minutes: Math.round(g.minutes) }))
      .sort((a, b) => b.minutes - a.minutes),
    verdict,
    notes,
  };
}

/** Days in a range that had at least one session, for the other modules. */
export async function trainingDays(db: Queryable, start: string, end: string): Promise<Set<string>> {
  const { rows } = await db.query('SELECT DISTINCT day FROM workouts WHERE day >= $1 AND day <= $2', [start, end]);
  return new Set(rows.map(r => dbDay(r.day)));
}
