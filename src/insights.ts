/**
 * The links that only show up across days: short night against next-day
 * intake, training against appetite, late eating against sleep.
 *
 * The discipline here is refusing to report. With a few weeks of one person's
 * data almost any split produces a difference, and most of those differences
 * are noise. So every comparison carries its sample sizes and the effect in
 * plain units, nothing is called a finding below a minimum group size, and
 * nothing here says "because". A split is an observation about what happened,
 * not a mechanism.
 */
import type { Queryable } from './db.js';
import { dayRange, dbDay, shiftDay, today } from './dates.js';

/** Below this many days on either side, a split is not worth printing. */
const MIN_GROUP = 4;

export interface Split {
  question: string;
  /** The condition that defines the first group, in words. */
  when: string;
  otherwise: string;
  n_when: number;
  n_otherwise: number;
  mean_when: number | null;
  mean_otherwise: number | null;
  difference: number | null;
  unit: string;
  /** True when both groups cleared MIN_GROUP. */
  reportable: boolean;
}

export interface Insights {
  window: { start: string; end: string; days: number };
  days_with_food: number;
  splits: Split[];
  notes: string[];
}

interface DayFacts {
  day: string;
  kcal: number | null;
  protein_g: number | null;
  meals: number;
  /** Minutes past midnight of the last meal, local. */
  last_meal_min: number | null;
  sleep_min: number | null;
  readiness: number | null;
  workout_min: number | null;
  steps: number | null;
}

async function facts(db: Queryable, start: string, end: string): Promise<Map<string, DayFacts>> {
  const out = new Map<string, DayFacts>();
  for (const day of dayRange(start, end)) {
    out.set(day, {
      day,
      kcal: null,
      protein_g: null,
      meals: 0,
      last_meal_min: null,
      sleep_min: null,
      readiness: null,
      workout_min: null,
      steps: null,
    });
  }

  const meals = await db.query(
    `SELECT day, SUM(kcal) AS kcal, SUM(protein_g) AS protein_g, COUNT(*) AS meals, MAX(eaten_at) AS last_at
       FROM meals WHERE day >= $1 AND day <= $2 GROUP BY day`,
    [start, end],
  );
  for (const r of meals.rows) {
    const f = out.get(dbDay(r.day));
    if (!f) continue;
    f.kcal = Number(r.kcal);
    f.protein_g = Number(r.protein_g);
    f.meals = Number(r.meals);
    f.last_meal_min = r.last_at ? minutesOfDay(new Date(r.last_at as string)) : null;
  }

  const metrics = await db.query(
    `SELECT day, MAX(sleep_min) AS sleep_min, MAX(readiness) AS readiness,
            MAX(workout_min) AS workout_min, MAX(steps) AS steps
       FROM daily_metrics WHERE day >= $1 AND day <= $2 GROUP BY day`,
    [start, end],
  );
  for (const r of metrics.rows) {
    const f = out.get(dbDay(r.day));
    if (!f) continue;
    f.sleep_min = r.sleep_min == null ? null : Number(r.sleep_min);
    f.readiness = r.readiness == null ? null : Number(r.readiness);
    f.workout_min = r.workout_min == null ? null : Number(r.workout_min);
    f.steps = r.steps == null ? null : Number(r.steps);
  }
  return out;
}

/** Local minutes past midnight; the column is a timestamptz. */
function minutesOfDay(d: Date): number {
  const s = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: process.env.TZ_LOCAL ?? 'Asia/Jerusalem',
  }).format(d);
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r0 = (v: number | null) => (v == null ? null : Math.round(v));

function split(
  question: string,
  when: string,
  otherwise: string,
  unit: string,
  rows: { cond: boolean; value: number }[],
): Split {
  const a = rows.filter(r => r.cond).map(r => r.value);
  const b = rows.filter(r => !r.cond).map(r => r.value);
  const ma = mean(a);
  const mb = mean(b);
  return {
    question,
    when,
    otherwise,
    n_when: a.length,
    n_otherwise: b.length,
    mean_when: r0(ma),
    mean_otherwise: r0(mb),
    difference: ma != null && mb != null ? Math.round(ma - mb) : null,
    unit,
    reportable: a.length >= MIN_GROUP && b.length >= MIN_GROUP,
  };
}

export async function insights(db: Queryable, days = 28, endDay: string = today()): Promise<Insights> {
  const start = shiftDay(endDay, -(days - 1));
  const f = await facts(db, start, endDay);
  const span = dayRange(start, endDay);
  const withFood = span.filter(d => (f.get(d)?.meals ?? 0) > 0);

  const splits: Split[] = [];

  // 1. A short night, and what the next day's eating looked like. The night
  //    recorded on day D is the night before D, so this pairs D with D.
  const sleepRows = withFood
    .map(d => f.get(d)!)
    .filter(x => x.sleep_min != null && x.kcal != null)
    .map(x => ({ cond: x.sleep_min! < 390, value: x.kcal! }));
  splits.push(
    split('Сколько съедено после короткого сна', 'сон меньше 6:30', 'сон 6:30 и больше', 'ккал', sleepRows),
  );

  // 2. Training days against the rest, on intake.
  const trainRows = withFood
    .map(d => f.get(d)!)
    .filter(x => x.kcal != null)
    .map(x => ({ cond: (x.workout_min ?? 0) >= 20, value: x.kcal! }));
  splits.push(split('Сколько съедено в дни с тренировкой', 'тренировка 20+ мин', 'без тренировки', 'ккал', trainRows));

  // 3. Late eating, and that night's sleep. The meal on day D precedes the
  //    sleep recorded on D+1, so this pairs across the boundary.
  const lateRows = withFood
    .map(d => ({ cur: f.get(d)!, next: f.get(shiftDay(d, 1)) }))
    .filter(x => x.cur.last_meal_min != null && x.next?.sleep_min != null)
    .map(x => ({ cond: x.cur.last_meal_min! >= 21 * 60, value: x.next!.sleep_min! }));
  splits.push(split('Сколько сна после позднего ужина', 'последняя еда после 21:00', 'раньше 21:00', 'мин', lateRows));

  // 4. Protein against training, since that is the gap worth watching.
  const proteinRows = withFood
    .map(d => f.get(d)!)
    .filter(x => x.protein_g != null)
    .map(x => ({ cond: (x.workout_min ?? 0) >= 20, value: x.protein_g! }));
  splits.push(split('Сколько белка в дни с тренировкой', 'тренировка 20+ мин', 'без тренировки', 'г', proteinRows));

  const notes: string[] = [];
  if (withFood.length < 2 * MIN_GROUP) {
    notes.push(
      `Дней с записанной едой: ${withFood.length}. Чтобы сравнивать группы, нужно хотя бы ${2 * MIN_GROUP}.`,
    );
  }
  if (!splits.some(s => s.reportable)) {
    notes.push('Ни одно сравнение пока не набрало по четыре дня в каждой группе.');
  }
  notes.push('Это описание того, что совпало по дням, а не причина и следствие.');

  return {
    window: { start, end: endDay, days: span.length },
    days_with_food: withFood.length,
    splits,
    notes,
  };
}
