/**
 * Oura API v2 → daily_metrics (source 'oura').
 * Personal access token: https://cloud.ouraring.com/personal-access-tokens
 */
import type { Queryable } from '../db.js';
import { shiftDay, today } from '../dates.js';
import { upsertMetrics } from '../service.js';

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

export interface OuraIngestResult {
  start: string;
  end: string;
  days: string[];
}

export async function ingestOura(db: Queryable, token: string, days = 3, endDay: string = today()): Promise<OuraIngestResult> {
  const start = shiftDay(endDay, -(days - 1));
  // Oura's end_date is exclusive for some collections; ask one day extra and filter.
  const end = shiftDay(endDay, 1);

  const [activity, sleepScores, readiness, sessions] = await Promise.all([
    fetchAll<DailyActivity>(token, 'daily_activity', start, end),
    fetchAll<DailyScore>(token, 'daily_sleep', start, end),
    fetchAll<DailyScore>(token, 'daily_readiness', start, end),
    fetchAll<SleepSession>(token, 'sleep', start, end),
  ]);

  const perDay = new Map<
    string,
    { activity?: DailyActivity; sleep_score?: number | null; readiness?: number | null; sessions: SleepSession[] }
  >();
  const slot = (day: string) => {
    let s = perDay.get(day);
    if (!s) perDay.set(day, (s = { sessions: [] }));
    return s;
  };
  for (const a of activity) if (a.day <= endDay) slot(a.day).activity = a;
  for (const s of sleepScores) if (s.day <= endDay) slot(s.day).sleep_score = s.score ?? null;
  for (const r of readiness) if (r.day <= endDay) slot(r.day).readiness = r.score ?? null;
  for (const s of sessions) if (s.day <= endDay) slot(s.day).sessions.push(s);

  const touched: string[] = [];
  for (const [day, d] of perDay) {
    // Main night = long_sleep sessions; fall back to everything if Oura didn't classify.
    const main = d.sessions.filter((s) => s.type === 'long_sleep');
    const nights = main.length ? main : d.sessions;
    const sleepSeconds = nights.reduce((acc, s) => acc + (s.total_sleep_duration ?? 0), 0);
    const hrvs = nights.map((s) => s.average_hrv).filter((v): v is number => v != null);
    const lows = nights.map((s) => s.lowest_heart_rate).filter((v): v is number => v != null);
    const a = d.activity;
    const workoutMin = a ? ((a.high_activity_time ?? 0) + (a.medium_activity_time ?? 0)) / 60 : null;

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
        workout_min: workoutMin && workoutMin > 0 ? workoutMin : null,
      },
      {
        activity_score: a?.score ?? null,
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
