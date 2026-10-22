/**
 * What the body actually spends, measured instead of assumed.
 *
 * A calorie target is normally a formula: a guess at resting metabolism times
 * a guess at an activity factor. Over a few weeks the scale answers the
 * question directly — if intake averaged X and weight fell by Y, expenditure
 * was X plus whatever that fall cost. This file does that arithmetic and is
 * careful to say when it does not have the evidence for it.
 *
 *   TDEE = mean intake + (weight lost × 7700) / days
 *
 * 7700 kcal per kilogram is the usual figure for body tissue. It is an
 * approximation, and so is everything built on it; the point is that it is an
 * approximation anchored to this person's own scale rather than to a
 * population average.
 */
import type { Queryable } from './db.js';
import { dayRange, dbDay, shiftDay, today } from './dates.js';
import { phasesByDay } from './cycle.js';
import { getTargets, weightTrend, type WeightTrend } from './service.js';

/** Energy in a kilogram of body tissue, the conventional figure. */
const KCAL_PER_KG = 7700;

/** Below this, day-to-day noise in water weight swamps the signal. */
const MIN_DAYS = 14;

/** A day with no meals logged is a hole, not a fast. */
const MIN_LOGGED_FRACTION = 0.8;

export type Confidence = 'none' | 'low' | 'medium' | 'high';

export interface EnergyBalance {
  window: { start: string; end: string; days: number };
  /** Days in the window that have at least one meal. */
  logged_days: number;
  mean_intake: number | null;
  weight: {
    start_avg7: number | null;
    end_avg7: number | null;
    change_kg: number | null;
    /** Kilograms per week, negative when losing. */
    rate_kg_week: number | null;
  };
  /** The measured figure, or null when the evidence is not there. */
  tdee: number | null;
  /** What the formula currently assumes, for comparison. */
  assumed_budget: number;
  confidence: Confidence;
  /** The budget that would produce the target rate, given the measured TDEE. */
  suggested_budget: number | null;
  /** Plain sentences about what is missing or what the number means. */
  notes: string[];
}

interface DayRow {
  day: string;
  kcal: number;
  meals: number;
}

async function intakeByDay(db: Queryable, start: string, end: string): Promise<Map<string, DayRow>> {
  const { rows } = await db.query(
    `SELECT day, SUM(kcal) AS kcal, COUNT(*) AS meals
       FROM meals WHERE day >= $1 AND day <= $2 GROUP BY day`,
    [start, end],
  );
  return new Map(
    rows.map(r => {
      const day = dbDay(r.day);
      return [day, { day, kcal: Number(r.kcal), meals: Number(r.meals) }];
    }),
  );
}

/**
 * Weight at the two ends of the window, smoothed. A single weigh-in is mostly
 * water, so both ends use the 7-day average when there is one.
 */
function ends(trend: WeightTrend, start: string, end: string) {
  const inWindow = trend.points.filter(p => p.day >= start && p.day <= end);
  const first = inWindow.find(p => p.avg7 != null) ?? inWindow[0] ?? null;
  const last = [...inWindow].reverse().find(p => p.avg7 != null) ?? inWindow.at(-1) ?? null;
  return {
    first: first ? { day: first.day, kg: first.avg7 ?? first.kg, smoothed: first.avg7 != null } : null,
    last: last ? { day: last.day, kg: last.avg7 ?? last.kg, smoothed: last.avg7 != null } : null,
    count: inWindow.length,
  };
}

export async function energyBalance(
  db: Queryable,
  days = 28,
  endDay: string = today(),
): Promise<EnergyBalance> {
  const start = shiftDay(endDay, -(days - 1));
  const span = dayRange(start, endDay);
  const [intake, trend, targets, phases] = await Promise.all([
    intakeByDay(db, start, endDay),
    weightTrend(db, days + 7, endDay),
    getTargets(db, endDay),
    phasesByDay(db, start, endDay),
  ]);

  const logged = span.filter(d => (intake.get(d)?.meals ?? 0) > 0);
  const meanIntake = logged.length
    ? Math.round(logged.reduce((a, d) => a + (intake.get(d)?.kcal ?? 0), 0) / logged.length)
    : null;

  const w = ends(trend, start, endDay);
  const spanDays =
    w.first && w.last && w.last.day > w.first.day
      ? (Date.parse(w.last.day) - Date.parse(w.first.day)) / 86_400_000
      : 0;
  const changeKg = w.first && w.last ? round1(w.last.kg - w.first.kg) : null;
  const rate = changeKg != null && spanDays >= 7 ? round1((changeKg / spanDays) * 7) : null;

  const notes: string[] = [];
  let confidence: Confidence = 'none';
  let tdee: number | null = null;

  const loggedFraction = span.length ? logged.length / span.length : 0;

  if (w.count < 2) {
    notes.push('Нужно хотя бы два взвешивания в окне — сейчас их меньше.');
  } else if (spanDays < MIN_DAYS) {
    notes.push(`Между первым и последним взвешиванием ${Math.round(spanDays)} дн.; нужно хотя бы ${MIN_DAYS}.`);
  } else if (!meanIntake) {
    notes.push('Нет ни одного дня с записанной едой.');
  } else if (loggedFraction < MIN_LOGGED_FRACTION) {
    notes.push(
      `Еда записана в ${logged.length} из ${span.length} дней. Пропущенные дни занижают средний приход, ` +
        'поэтому расход получился бы завышенным.',
    );
  } else {
    // The sign works out: losing weight means changeKg is negative, so the
    // body spent more than came in by exactly that much.
    tdee = Math.round(meanIntake - (changeKg! * KCAL_PER_KG) / spanDays);
    // A 28-day window can only ever span 27 days between its end points, so
    // the bar for "high" is near-full coverage, not a round number above it.
    confidence = spanDays >= 25 && loggedFraction >= 0.9 ? 'high' : spanDays >= 21 ? 'medium' : 'low';
    notes.push(
      `Посчитано по ${logged.length} дням еды и изменению веса на ${fmt(changeKg!)} кг за ${Math.round(spanDays)} дн.`,
    );
    if (!w.first!.smoothed || !w.last!.smoothed) {
      notes.push('Один из концов окна — разовое взвешивание, а не среднее за 7 дней: шум по воде сюда попадает.');
    }
  }

  // Water weight moves with the cycle, so two weigh-ins taken in different
  // phases can differ by more than a fortnight of fat. Say so rather than
  // quietly folding it into the answer.
  if (tdee != null && w.first && w.last) {
    const a = phases.get(w.first.day);
    const b = phases.get(w.last.day);
    if (a && b && a !== 'неизвестно' && b !== 'неизвестно' && a !== b) {
      notes.push(
        `Концы окна в разных фазах цикла (${a} → ${b}). Вода между фазами гуляет на 1–2 кг, ` +
          'так что к числу стоит относиться как к оценке, а не как к измерению.',
      );
    }
  }

  // The target rate the person is actually aiming at, as a daily deficit.
  const targetRate = 0.5; // kg per week
  const suggested =
    tdee != null ? Math.max(targets.min_kcal, Math.round(tdee - (targetRate * KCAL_PER_KG) / 7)) : null;

  if (tdee != null) {
    const diff = tdee - targets.kcal;
    if (Math.abs(diff) >= 100) {
      notes.push(
        diff > 0
          ? `Измеренный расход на ${diff} ккал выше базы ${targets.kcal}, на которой стоит бюджет.`
          : `Измеренный расход на ${Math.abs(diff)} ккал ниже базы ${targets.kcal}, на которой стоит бюджет.`,
      );
    }
  }

  return {
    window: { start, end: endDay, days: span.length },
    logged_days: logged.length,
    mean_intake: meanIntake,
    weight: {
      start_avg7: w.first?.kg ?? null,
      end_avg7: w.last?.kg ?? null,
      change_kg: changeKg,
      rate_kg_week: rate,
    },
    tdee,
    assumed_budget: targets.kcal,
    confidence,
    suggested_budget: suggested,
    notes,
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => (v > 0 ? `+${v}` : String(v));
