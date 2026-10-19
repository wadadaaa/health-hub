import type { Queryable } from './db.js';
import { dayRange, dbDay, dbInstant, localDay, shiftDay, today } from './dates.js';

// ---------- types ----------

export interface Meal {
  id: number;
  day: string;
  eaten_at: string;
  description: string;
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  confidence: string | null;
  source: string;
}

export interface Targets {
  id: number;
  valid_from: string;
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  active_factor: number;
  active_baseline: number;
  min_kcal: number;
  note: string | null;
}

export interface MetricFields {
  active_kcal?: number | null;
  steps?: number | null;
  resting_hr?: number | null;
  hrv?: number | null;
  sleep_min?: number | null;
  readiness?: number | null;
  workout_min?: number | null;
}

export interface Metrics extends MetricFields {
  sources: string[];
}

export interface Budget {
  base: number;
  active_kcal: number | null;
  extra: number;
  adjusted: number;
  day_type: 'office' | 'training';
  rule: string;
}

export interface Macros {
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
}

export interface DaySummary {
  day: string;
  budget: Budget;
  targets: Macros;
  consumed: Macros & { meals: number };
  remaining: Macros;
  meals: Meal[];
  metrics: Metrics;
  weight: { kg: number; day: string } | null;
}

// ---------- helpers ----------

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const r1 = (v: number) => Math.round(v * 10) / 10;

const MEAL_COLS = `id, day, eaten_at, description, kcal, protein_g, fat_g, carbs_g, confidence, source`;

const TARGET_COLS = `id, valid_from, kcal, protein_g, fat_g, carbs_g, active_factor, active_baseline, min_kcal, note`;

/** Rows come back with Date objects and NUMERIC-as-string; normalise once here. */
function toMeal(r: Record<string, unknown>): Meal {
  return {
    id: Number(r.id),
    day: dbDay(r.day),
    eaten_at: dbInstant(r.eaten_at),
    description: String(r.description),
    kcal: Number(r.kcal),
    protein_g: num(r.protein_g),
    fat_g: num(r.fat_g),
    carbs_g: num(r.carbs_g),
    confidence: r.confidence == null ? null : String(r.confidence),
    source: String(r.source),
  };
}

function toTargets(r: Record<string, unknown>): Targets {
  return {
    id: Number(r.id),
    valid_from: dbDay(r.valid_from),
    kcal: Number(r.kcal),
    protein_g: Number(r.protein_g),
    fat_g: Number(r.fat_g),
    carbs_g: Number(r.carbs_g),
    active_factor: Number(r.active_factor),
    active_baseline: Number(r.active_baseline),
    min_kcal: Number(r.min_kcal),
    note: r.note == null ? null : String(r.note),
  };
}

function toWeight(r: Record<string, unknown>): Weight {
  return {
    id: Number(r.id),
    day: dbDay(r.day),
    measured_at: dbInstant(r.measured_at),
    kg: Number(r.kg),
    source: String(r.source),
  };
}

// ---------- meals ----------

export interface LogMealInput {
  description: string;
  kcal: number;
  protein_g?: number;
  fat_g?: number;
  carbs_g?: number;
  eaten_at?: Date;
  confidence?: 'low' | 'medium' | 'high';
  source?: string;
}

export async function logMeal(db: Queryable, input: LogMealInput): Promise<Meal> {
  const eatenAt = input.eaten_at ?? new Date();
  const day = localDay(eatenAt);
  const { rows } = await db.query(
    `INSERT INTO meals (day, eaten_at, description, kcal, protein_g, fat_g, carbs_g, confidence, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${MEAL_COLS}`,
    [
      day,
      eatenAt.toISOString(),
      input.description,
      Math.round(input.kcal),
      r1(input.protein_g ?? 0),
      r1(input.fat_g ?? 0),
      r1(input.carbs_g ?? 0),
      input.confidence ?? null,
      input.source ?? 'claude',
    ],
  );
  return toMeal(rows[0]);
}

export type UpdateMealInput = Partial<Omit<LogMealInput, 'source'>>;

export async function updateMeal(db: Queryable, id: number, patch: UpdateMealInput): Promise<Meal | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.description !== undefined) push('description', patch.description);
  if (patch.kcal !== undefined) push('kcal', Math.round(patch.kcal));
  if (patch.protein_g !== undefined) push('protein_g', r1(patch.protein_g));
  if (patch.fat_g !== undefined) push('fat_g', r1(patch.fat_g));
  if (patch.carbs_g !== undefined) push('carbs_g', r1(patch.carbs_g));
  if (patch.confidence !== undefined) push('confidence', patch.confidence);
  if (patch.eaten_at !== undefined) {
    push('eaten_at', patch.eaten_at.toISOString());
    push('day', localDay(patch.eaten_at));
  }
  if (sets.length === 0) return getMeal(db, id);
  params.push(id);
  const { rows } = await db.query(
    `UPDATE meals SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${MEAL_COLS}`,
    params,
  );
  return rows[0] ? toMeal(rows[0]) : null;
}

export async function getMeal(db: Queryable, id: number): Promise<Meal | null> {
  const { rows } = await db.query(`SELECT ${MEAL_COLS} FROM meals WHERE id = $1`, [id]);
  return rows[0] ? toMeal(rows[0]) : null;
}

export async function deleteMeal(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM meals WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function listMeals(db: Queryable, day: string): Promise<Meal[]> {
  const { rows } = await db.query(
    `SELECT ${MEAL_COLS} FROM meals WHERE day = $1 ORDER BY eaten_at ASC, id ASC`,
    [day],
  );
  return rows.map(toMeal);
}

// ---------- targets ----------

export async function getTargets(db: Queryable, day: string = today()): Promise<Targets> {
  const { rows } = await db.query(
    `SELECT ${TARGET_COLS} FROM targets WHERE valid_from <= $1 ORDER BY valid_from DESC, id DESC LIMIT 1`,
    [day],
  );
  if (rows[0]) return toTargets(rows[0]);
  // Nothing valid yet for this day (e.g. asking about a day before the first targets row): fall back to the earliest.
  const any = await db.query(`SELECT ${TARGET_COLS} FROM targets ORDER BY valid_from ASC, id ASC LIMIT 1`);
  if (!any.rows[0]) throw new Error('No targets configured. Call set_targets first.');
  return toTargets(any.rows[0]);
}

export interface SetTargetsInput {
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  active_factor?: number;
  active_baseline?: number;
  min_kcal?: number;
  valid_from?: string;
  note?: string;
}

export async function setTargets(db: Queryable, input: SetTargetsInput): Promise<Targets> {
  const prev = await getTargets(db).catch(() => null);
  const { rows } = await db.query(
    `INSERT INTO targets (valid_from, kcal, protein_g, fat_g, carbs_g, active_factor, active_baseline, min_kcal, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${TARGET_COLS}`,
    [
      input.valid_from ?? today(),
      Math.round(input.kcal),
      Math.round(input.protein_g),
      Math.round(input.fat_g),
      Math.round(input.carbs_g),
      input.active_factor ?? prev?.active_factor ?? 0.6,
      input.active_baseline ?? prev?.active_baseline ?? 300,
      input.min_kcal ?? prev?.min_kcal ?? 1400,
      input.note ?? null,
    ],
  );
  return toTargets(rows[0]);
}

// ---------- metrics ----------

interface MetricRow extends MetricFields {
  source: string;
}

/** Field-level precedence when several sources report the same day. First match wins. */
const PRECEDENCE: Record<keyof MetricFields, string[]> = {
  active_kcal: ['manual', 'apple', 'oura'],
  steps: ['manual', 'apple', 'oura'],
  workout_min: ['manual', 'apple', 'oura'],
  resting_hr: ['manual', 'oura', 'apple'],
  hrv: ['manual', 'oura', 'apple'],
  sleep_min: ['manual', 'oura', 'apple'],
  readiness: ['manual', 'oura'],
};

export async function getMetrics(db: Queryable, day: string): Promise<Metrics> {
  const { rows } = await db.query<MetricRow>(
    `SELECT source, active_kcal, steps, resting_hr, hrv, sleep_min, readiness, workout_min
     FROM daily_metrics WHERE day = $1`,
    [day],
  );
  const bySource = new Map(rows.map((r) => [r.source, r]));
  const out: Metrics = { sources: rows.map((r) => r.source).sort() };
  for (const field of Object.keys(PRECEDENCE) as (keyof MetricFields)[]) {
    let value: number | null = null;
    for (const src of PRECEDENCE[field]) {
      const v = bySource.get(src)?.[field];
      if (v != null) {
        value = Number(v);
        break;
      }
    }
    out[field] = value;
  }
  return out;
}

export async function upsertMetrics(
  db: Queryable,
  day: string,
  source: string,
  fields: MetricFields,
  payload?: unknown,
): Promise<void> {
  const clean = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? null : v);
  await db.query(
    `INSERT INTO daily_metrics (day, source, active_kcal, steps, resting_hr, hrv, sleep_min, readiness, workout_min, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (day, source) DO UPDATE SET
       active_kcal = COALESCE(EXCLUDED.active_kcal, daily_metrics.active_kcal),
       steps       = COALESCE(EXCLUDED.steps,       daily_metrics.steps),
       resting_hr  = COALESCE(EXCLUDED.resting_hr,  daily_metrics.resting_hr),
       hrv         = COALESCE(EXCLUDED.hrv,         daily_metrics.hrv),
       sleep_min   = COALESCE(EXCLUDED.sleep_min,   daily_metrics.sleep_min),
       readiness   = COALESCE(EXCLUDED.readiness,   daily_metrics.readiness),
       workout_min = COALESCE(EXCLUDED.workout_min, daily_metrics.workout_min),
       payload     = COALESCE(EXCLUDED.payload,     daily_metrics.payload),
       updated_at  = now()`,
    [
      day,
      source,
      clean(fields.active_kcal == null ? null : Math.round(fields.active_kcal)),
      clean(fields.steps == null ? null : Math.round(fields.steps)),
      clean(fields.resting_hr == null ? null : Math.round(fields.resting_hr)),
      clean(fields.hrv == null ? null : r1(fields.hrv)),
      clean(fields.sleep_min == null ? null : Math.round(fields.sleep_min)),
      clean(fields.readiness == null ? null : Math.round(fields.readiness)),
      clean(fields.workout_min == null ? null : Math.round(fields.workout_min)),
      payload === undefined ? null : JSON.stringify(payload),
    ],
  );
}

// ---------- weights ----------

export interface Weight {
  id: number;
  day: string;
  measured_at: string;
  kg: number;
  source: string;
}

export async function logWeight(
  db: Queryable,
  kg: number,
  measuredAt: Date = new Date(),
  source = 'manual',
): Promise<Weight> {
  const { rows } = await db.query(
    `INSERT INTO weights (day, measured_at, kg, source) VALUES ($1, $2, $3, $4)
     RETURNING id, day, measured_at, kg, source`,
    [localDay(measuredAt), measuredAt.toISOString(), Math.round(kg * 100) / 100, source],
  );
  return toWeight(rows[0]);
}

export interface WeightTrend {
  days: number;
  points: { day: string; kg: number; avg7: number | null }[];
  latest: { day: string; kg: number } | null;
  avg7_now: number | null;
  avg7_week_ago: number | null;
  delta_week: number | null; // avg7_now - avg7_week_ago, negative = losing
}

export async function weightTrend(db: Queryable, days = 28, endDay: string = today()): Promise<WeightTrend> {
  const start = shiftDay(endDay, -(days + 7)); // extra week so the first avg7 has data
  const { rows } = await db.query(
    `SELECT day, AVG(kg) AS kg FROM weights
     WHERE day >= $1 AND day <= $2 GROUP BY day ORDER BY day ASC`,
    [start, endDay],
  );
  const byDay = new Map(rows.map((r) => [dbDay(r.day), Number(r.kg)]));
  const points: WeightTrend['points'] = [];
  for (const day of dayRange(shiftDay(endDay, -days), endDay)) {
    const kg = byDay.get(day);
    if (kg == null) continue;
    const window = dayRange(shiftDay(day, -6), day)
      .map((d) => byDay.get(d))
      .filter((v): v is number => v != null);
    const avg7 = window.length >= 3 ? r1(window.reduce((a, b) => a + b, 0) / window.length) : null;
    points.push({ day, kg: r1(kg), avg7 });
  }
  const latest = points.at(-1) ?? null;
  const avg7Now = latest?.avg7 ?? null;
  const weekAgoPoint = [...points].reverse().find((p) => p.day <= shiftDay(endDay, -7) && p.avg7 != null) ?? null;
  const avg7WeekAgo = weekAgoPoint?.avg7 ?? null;
  return {
    days,
    points,
    latest: latest ? { day: latest.day, kg: latest.kg } : null,
    avg7_now: avg7Now,
    avg7_week_ago: avg7WeekAgo,
    delta_week: avg7Now != null && avg7WeekAgo != null ? r1(avg7Now - avg7WeekAgo) : null,
  };
}

async function latestWeight(db: Queryable, onOrBefore: string): Promise<{ kg: number; day: string } | null> {
  const { rows } = await db.query(
    `SELECT kg, day FROM weights WHERE day <= $1 ORDER BY measured_at DESC, id DESC LIMIT 1`,
    [onOrBefore],
  );
  return rows[0] ? { kg: Number(rows[0].kg), day: dbDay(rows[0].day) } : null;
}

// ---------- budget & day summary ----------

export function computeBudget(t: Targets, m: Metrics): Budget {
  const active = m.active_kcal ?? null;
  const extra = active == null ? 0 : Math.round(t.active_factor * Math.max(0, active - t.active_baseline));
  const adjusted = Math.max(t.min_kcal, t.kcal + extra);
  const isTraining = (m.workout_min ?? 0) >= 20 || (active != null && active >= t.active_baseline + 250);
  return {
    base: t.kcal,
    active_kcal: active,
    extra,
    adjusted,
    day_type: isTraining ? 'training' : 'office',
    rule: `base ${t.kcal} + ${t.active_factor} × max(0, active − ${t.active_baseline}); min ${t.min_kcal}`,
  };
}

export async function getDay(db: Queryable, day: string = today()): Promise<DaySummary> {
  const [targets, meals, metrics, weight] = await Promise.all([
    getTargets(db, day),
    listMeals(db, day),
    getMetrics(db, day),
    latestWeight(db, day),
  ]);
  const budget = computeBudget(targets, metrics);
  const consumed = meals.reduce(
    (acc, m) => ({
      kcal: acc.kcal + num(m.kcal),
      protein_g: acc.protein_g + num(m.protein_g),
      fat_g: acc.fat_g + num(m.fat_g),
      carbs_g: acc.carbs_g + num(m.carbs_g),
    }),
    { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );
  // Extra budget from activity goes to carbs (fuel); protein and fat targets stay fixed.
  const targetMacros: Macros = {
    kcal: budget.adjusted,
    protein_g: targets.protein_g,
    fat_g: targets.fat_g,
    carbs_g: targets.carbs_g + Math.round(budget.extra / 4),
  };
  return {
    day,
    budget,
    targets: targetMacros,
    consumed: {
      kcal: Math.round(consumed.kcal),
      protein_g: r1(consumed.protein_g),
      fat_g: r1(consumed.fat_g),
      carbs_g: r1(consumed.carbs_g),
      meals: meals.length,
    },
    remaining: {
      kcal: Math.round(targetMacros.kcal - consumed.kcal),
      protein_g: r1(targetMacros.protein_g - consumed.protein_g),
      fat_g: r1(targetMacros.fat_g - consumed.fat_g),
      carbs_g: r1(targetMacros.carbs_g - consumed.carbs_g),
    },
    meals,
    metrics,
    weight,
  };
}

export interface WeekSummary {
  start: string;
  end: string;
  days: {
    day: string;
    day_type: Budget['day_type'];
    budget: number;
    consumed: number;
    delta: number; // consumed - budget; negative = under budget
    protein_g: number;
    meals: number;
    active_kcal: number | null;
    steps: number | null;
    sleep_min: number | null;
    readiness: number | null;
  }[];
  logged_days: number;
  avg_consumed: number | null;
  avg_budget: number | null;
  avg_delta: number | null;
  avg_protein_g: number | null;
  weight: WeightTrend;
}

export async function getWeek(db: Queryable, endDay: string = today()): Promise<WeekSummary> {
  const start = shiftDay(endDay, -6);
  const summaries = await Promise.all(dayRange(start, endDay).map((d) => getDay(db, d)));
  const days = summaries.map((s) => ({
    day: s.day,
    day_type: s.budget.day_type,
    budget: s.budget.adjusted,
    consumed: s.consumed.kcal,
    delta: s.consumed.kcal - s.budget.adjusted,
    protein_g: s.consumed.protein_g,
    meals: s.consumed.meals,
    active_kcal: s.metrics.active_kcal ?? null,
    steps: s.metrics.steps ?? null,
    sleep_min: s.metrics.sleep_min ?? null,
    readiness: s.metrics.readiness ?? null,
  }));
  const logged = days.filter((d) => d.meals > 0);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    start,
    end: endDay,
    days,
    logged_days: logged.length,
    avg_consumed: avg(logged.map((d) => d.consumed)),
    avg_budget: avg(logged.map((d) => d.budget)),
    avg_delta: avg(logged.map((d) => d.delta)),
    avg_protein_g: avg(logged.map((d) => d.protein_g)),
    weight: await weightTrend(db, 28, endDay),
  };
}

export { numOrNull };
