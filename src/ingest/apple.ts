/**
 * Parser for the "Health Auto Export" iOS app REST payload
 * (Automations → REST API → JSON). Tolerant on purpose: metric names, units and
 * aggregation granularity depend on the user's export settings, so anything we
 * cannot map is kept in `payload` and reported in `unknown`.
 *
 * Also accepts the simpler hand-rolled Shortcut payload (see parseShortcutPayload).
 */
import type { Queryable } from '../db.js';
import { localDay, parseLooseDate } from '../dates.js';
import { logWeight, upsertMetrics, type MetricFields } from '../service.js';

interface Sample {
  date?: string;
  qty?: number | string;
  value?: number | string;
  avg?: number | string;
  Avg?: number | string;
  // sleep_analysis fields (hours)
  asleep?: number | string;
  totalSleep?: number | string;
  inBed?: number | string;
  [k: string]: unknown;
}

interface Metric {
  name?: string;
  units?: string;
  data?: Sample[];
}

interface Workout {
  name?: string;
  start?: string;
  end?: string;
  duration?: number | string; // seconds in current exports
  activeEnergyBurned?: { qty?: number | string; units?: string } | number;
  [k: string]: unknown;
}

export interface HealthAutoExportPayload {
  data?: { metrics?: Metric[]; workouts?: Workout[] };
  metrics?: Metric[];
  workouts?: Workout[];
}

const n = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

const sampleValue = (s: Sample): number | null => n(s.qty) ?? n(s.value) ?? n(s.avg) ?? n(s.Avg);

function toKcal(value: number, units?: string): number {
  const u = (units ?? '').toLowerCase();
  if (u === 'kj') return value / 4.184;
  if (u === 'j') return value / 4184;
  return value; // kcal / Cal
}

function toKg(value: number, units?: string): number {
  const u = (units ?? '').toLowerCase();
  if (u === 'lb' || u === 'lbs') return value * 0.45359237;
  if (u === 'g') return value / 1000;
  return value;
}

/** Normalise metric names across HAE versions: 'active_energy', 'Active Energy', 'activeEnergyBurned'. */
function key(name?: string): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

type Agg = { sum: number; count: number; max: number };
const agg = () => ({ sum: 0, count: 0, max: -Infinity });
const add = (a: Agg, v: number) => {
  a.sum += v;
  a.count += 1;
  a.max = Math.max(a.max, v);
};

export interface AppleIngestResult {
  days: string[];
  weights: number;
  unknown: string[];
}

export async function ingestHealthAutoExport(db: Queryable, body: HealthAutoExportPayload): Promise<AppleIngestResult> {
  const metrics = body.data?.metrics ?? body.metrics ?? [];
  const workouts = body.data?.workouts ?? body.workouts ?? [];

  const perDay = new Map<string, Record<string, Agg>>();
  const dayAgg = (day: string, field: string): Agg => {
    let d = perDay.get(day);
    if (!d) perDay.set(day, (d = {}));
    return (d[field] ??= agg());
  };
  const unknown = new Set<string>();
  const weightSamples: { at: Date; kg: number }[] = [];

  for (const m of metrics) {
    const k = key(m.name);
    for (const s of m.data ?? []) {
      const at = s.date ? parseLooseDate(s.date) : null;
      if (!at) continue;
      const day = localDay(at);
      switch (k) {
        case 'activeenergy':
        case 'activeenergyburned': {
          const v = sampleValue(s);
          if (v != null) add(dayAgg(day, 'active_kcal'), toKcal(v, m.units));
          break;
        }
        case 'stepcount':
        case 'steps': {
          const v = sampleValue(s);
          if (v != null) add(dayAgg(day, 'steps'), v);
          break;
        }
        case 'restingheartrate': {
          const v = sampleValue(s);
          if (v != null) add(dayAgg(day, 'resting_hr'), v);
          break;
        }
        case 'heartratevariability':
        case 'heartratevariabilitysdnn': {
          const v = sampleValue(s);
          if (v != null) add(dayAgg(day, 'hrv'), v);
          break;
        }
        case 'sleepanalysis': {
          // Hours; HAE reports one sample per night keyed by the wake-up date.
          const hours = n(s.asleep) ?? n(s.totalSleep) ?? sampleValue(s);
          if (hours != null) add(dayAgg(day, 'sleep_min'), hours * 60);
          break;
        }
        case 'weightbodymass':
        case 'bodymass':
        case 'weight': {
          const v = sampleValue(s);
          if (v != null) weightSamples.push({ at, kg: toKg(v, m.units) });
          break;
        }
        case 'appleexercisetime': {
          const v = sampleValue(s);
          if (v != null) add(dayAgg(day, 'exercise_min'), v);
          break;
        }
        default:
          if (k) unknown.add(m.name ?? k);
      }
    }
  }

  for (const w of workouts) {
    const start = w.start ? parseLooseDate(w.start) : null;
    if (!start) continue;
    const day = localDay(start);
    let seconds = n(w.duration);
    if (seconds == null && w.end) {
      const end = parseLooseDate(w.end);
      if (end) seconds = (end.getTime() - start.getTime()) / 1000;
    }
    if (seconds != null) add(dayAgg(day, 'workout_min'), seconds / 60);
  }

  const days: string[] = [];
  for (const [day, fields] of perDay) {
    const f: MetricFields = {
      active_kcal: fields.active_kcal ? fields.active_kcal.sum : null,
      steps: fields.steps ? fields.steps.sum : null,
      resting_hr: fields.resting_hr ? fields.resting_hr.sum / fields.resting_hr.count : null,
      hrv: fields.hrv ? fields.hrv.sum / fields.hrv.count : null,
      sleep_min: fields.sleep_min ? fields.sleep_min.sum : null,
      // Prefer real workouts; fall back to Apple "exercise minutes" ring.
      workout_min: fields.workout_min ? fields.workout_min.sum : fields.exercise_min ? fields.exercise_min.sum : null,
    };
    const payload = Object.fromEntries(
      Object.entries(fields).map(([k, a]) => [k, { sum: Math.round(a.sum * 10) / 10, count: a.count }]),
    );
    await upsertMetrics(db, day, 'apple', f, payload);
    days.push(day);
  }

  for (const w of weightSamples) await logWeight(db, w.kg, w.at, 'apple');

  return { days: days.sort(), weights: weightSamples.length, unknown: [...unknown].sort() };
}

/** Minimal payload for a hand-made iOS Shortcut: { date?, active_kcal?, steps?, resting_hr?, hrv?, sleep_min?, workout_min?, weight_kg? } */
export interface ShortcutPayload {
  date?: string;
  active_kcal?: number | string;
  steps?: number | string;
  resting_hr?: number | string;
  hrv?: number | string;
  sleep_min?: number | string;
  readiness?: number | string;
  workout_min?: number | string;
  weight_kg?: number | string;
  source?: string;
}

export async function ingestShortcut(db: Queryable, body: ShortcutPayload): Promise<{ day: string; weight: boolean }> {
  const day = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : localDay();
  const source = body.source === 'manual' ? 'manual' : 'apple';
  await upsertMetrics(
    db,
    day,
    source,
    {
      active_kcal: n(body.active_kcal),
      steps: n(body.steps),
      resting_hr: n(body.resting_hr),
      hrv: n(body.hrv),
      sleep_min: n(body.sleep_min),
      readiness: n(body.readiness),
      workout_min: n(body.workout_min),
    },
    body,
  );
  const kg = n(body.weight_kg);
  if (kg != null) await logWeight(db, kg, new Date(), source);
  return { day, weight: kg != null };
}
