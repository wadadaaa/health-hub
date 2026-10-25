/**
 * Oura API v2 → daily_metrics (source 'oura').
 * Personal access token: https://cloud.ouraring.com/personal-access-tokens
 */
import type { Queryable } from '../db.js';
import { shiftDay, today } from '../dates.js';
import { upsertMetrics } from '../service.js';
import { logWorkout } from '../training.js';

const BASE = 'https://api.ouraring.com/v2/usercollection';

interface Page<T> {
  data: T[];
  next_token?: string | null;
}

async function fetchAll<T>(token: string, path: string, start: string, end: string): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set('start_date', start);
    url.searchParams.set('end_date', end);
    if (nextToken) url.searchParams.set('next_token', nextToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Oura ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as Page<T>;
    out.push(...(page.data ?? []));
    if (!page.next_token) break;
    nextToken = page.next_token;
  }
  return out;
}

interface DailyActivity {
  day: string;
  score?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  steps?: number | null;
  high_activity_time?: number | null;
  medium_activity_time?: number | null;
}
interface DailyScore {
  day: string;
  score?: number | null;
  // Readiness carries the nightly skin-temperature deviation from the
  // wearer's own baseline. Optional on purpose: if Oura stops sending it the
  // sync should lose the field, not the day.
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
}
interface Workout {
  id?: string | null;
  day: string;
  activity?: string | null;
  calories?: number | null;
  intensity?: string | null;
  label?: string | null;
  source?: string | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
}
interface SleepSession {
  day: string;
  type?: string;
  total_sleep_duration?: number | null; // seconds
  average_hrv?: number | null;
  lowest_heart_rate?: number | null;
  bedtime_start?: string;
  bedtime_end?: string;
}

/** Total minutes of a set of workouts, from their own start and end times. */
function minutes(ws: Workout[]): number {
  let total = 0;
  for (const w of ws) {
    if (!w.start_datetime || !w.end_datetime) continue;
    const ms = Date.parse(w.end_datetime) - Date.parse(w.start_datetime);
    if (Number.isFinite(ms) && ms > 0) total += ms / 60000;
  }
  return Math.round(total);
}

export interface OuraIngestResult {
  start: string;
  end: string;
  days: string[];
}

/** A bearer token, or something that produces one (OAuth2 refreshes on demand). */
export type TokenSource = string | (() => Promise<string | null>);

async function resolveToken(source: TokenSource): Promise<string> {
  const token = typeof source === 'string' ? source : await source();
  if (!token) throw new Error('Oura is not connected');
  return token;
}

export async function ingestOura(
  db: Queryable,
  tokenSource: TokenSource,
  days = 3,
  endDay: string = today(),
): Promise<OuraIngestResult> {
  const token = await resolveToken(tokenSource);
  const start = shiftDay(endDay, -(days - 1));
  // Oura's end_date is exclusive for some collections; ask one day extra and filter.
  const end = shiftDay(endDay, 1);

  const [activity, sleepScores, readiness, sessions, workouts] = await Promise.all([
    fetchAll<DailyActivity>(token, 'daily_activity', start, end),
    fetchAll<DailyScore>(token, 'daily_sleep', start, end),
    fetchAll<DailyScore>(token, 'daily_readiness', start, end),
    fetchAll<SleepSession>(token, 'sleep', start, end),
    // Deliberately tolerant: a missing workout scope should cost the workouts,
    // not the whole sync.
    fetchAll<Workout>(token, 'workout', start, end).catch((e) => {
      console.warn('[oura] workouts unavailable:', e instanceof Error ? e.message : e);
      return [] as Workout[];
    }),
  ]);

  const perDay = new Map<
    string,
    {
      activity?: DailyActivity;
      sleep_score?: number | null;
      readiness?: number | null;
      temp_deviation?: number | null;
      sessions: SleepSession[];
      workouts: Workout[];
    }
  >();
  const slot = (day: string) => {
    let s = perDay.get(day);
    if (!s) perDay.set(day, (s = { sessions: [], workouts: [] }));
    return s;
  };
  for (const a of activity) if (a.day <= endDay) slot(a.day).activity = a;
  for (const s of sleepScores) if (s.day <= endDay) slot(s.day).sleep_score = s.score ?? null;
  for (const r of readiness) {
    if (r.day > endDay) continue;
    const t = slot(r.day);
    t.readiness = r.score ?? null;
    t.temp_deviation = r.temperature_deviation ?? r.temperature_trend_deviation ?? null;
  }
  for (const s of sessions) if (s.day <= endDay) slot(s.day).sessions.push(s);
  for (const w of workouts) if (w.day <= endDay) slot(w.day).workouts.push(w);

  const touched: string[] = [];
  for (const [day, d] of perDay) {
    // Main night = long_sleep sessions; fall back to everything if Oura didn't classify.
    const main = d.sessions.filter((s) => s.type === 'long_sleep');
    const nights = main.length ? main : d.sessions;
    const sleepSeconds = nights.reduce((acc, s) => acc + (s.total_sleep_duration ?? 0), 0);
    const hrvs = nights.map((s) => s.average_hrv).filter((v): v is number => v != null);
    const lows = nights.map((s) => s.lowest_heart_rate).filter((v): v is number => v != null);
    const a = d.activity;
    // Real sessions only. Summing Oura's high and medium activity instead puts
    // an hour of ordinary walking in here and makes every day a training day.
    const workoutMin = minutes(d.workouts);
    // Kept because it is genuinely useful, just not as "workout".
    const activeMin = a ? ((a.high_activity_time ?? 0) + (a.medium_activity_time ?? 0)) / 60 : null;

    // Each session also gets its own row, so a plan has something to be judged
    // against. Oura knows what and how long; only she knows how hard.
    for (const w of d.workouts) {
      const mins = minutes([w]);
      if (!w.start_datetime || mins <= 0) continue;
      try {
        await logWorkout(db, {
          sport: w.activity ?? 'workout',
          minutes: mins,
          started_at: new Date(w.start_datetime),
          kcal: w.calories ?? null,
          source: 'oura',
          external_id: w.id ?? `${w.start_datetime}:${w.activity ?? ''}`,
          note: w.label ?? null,
        });
      } catch (e) {
        console.error('[oura] workout not stored:', e instanceof Error ? e.message : e);
      }
    }

    await upsertMetrics(
      db,
      day,
      'oura',
      {
        active_kcal: a?.active_calories ?? null,
        steps: a?.steps ?? null,
        sleep_min: sleepSeconds ? sleepSeconds / 60 : null,
        hrv: hrvs.length ? hrvs.reduce((x, y) => x + y, 0) / hrvs.length : null,
        resting_hr: lows.length ? Math.min(...lows) : null,
        readiness: d.readiness ?? null,
        workout_min: workoutMin > 0 ? workoutMin : null,
        temp_deviation: d.temp_deviation ?? null,
      },
      {
        activity_score: a?.score ?? null,
        active_minutes: activeMin && activeMin > 0 ? Math.round(activeMin) : null,
        workouts: d.workouts.map((w) => ({
          activity: w.activity ?? null,
          intensity: w.intensity ?? null,
          source: w.source ?? null,
          minutes: Math.round(minutes([w])),
          calories: w.calories ?? null,
        })),
        total_calories: a?.total_calories ?? null,
        sleep_score: d.sleep_score ?? null,
        readiness: d.readiness ?? null,
        sessions: nights.map((s) => ({
          type: s.type,
          start: s.bedtime_start,
          end: s.bedtime_end,
          total_sleep_min: s.total_sleep_duration ? Math.round(s.total_sleep_duration / 60) : null,
        })),
      },
    );
    touched.push(day);
  }
  return { start, end: endDay, days: touched.sort() };
}
