/**
 * The menstrual cycle, and what it does to everything else in this database.
 *
 * Oura has no cycle endpoint, so a period start is something she tells the
 * bot. From a handful of those, her own cycle length falls out, and from that
 * a phase for any day. The phase is a prediction, not an observation, and this
 * file is careful to keep saying so.
 *
 * Why a weight-loss tool cares: fluid retention in the luteal phase commonly
 * moves the scale by one to two kilograms, which is larger than a fortnight of
 * real fat loss. Read without it, a trend shows a plateau that is not there,
 * and the obvious response to an imaginary plateau — cut further — is the
 * wrong one. Appetite also tends to rise premenstrually and expenditure rises
 * slightly in the luteal phase; both are smaller effects than the water, and
 * both are easier to accept when they are expected.
 */
import type { Queryable } from './db.js';
import { dbDay, shiftDay, today } from './dates.js';

export type Phase = 'менструальная' | 'фолликулярная' | 'овуляторная' | 'лютеиновая' | 'неизвестно';

/** Used only until she has logged two periods of her own. */
const ASSUMED_LENGTH = 28;

/** The luteal phase is the stable part: ovulation is this far before the next start. */
const LUTEAL_DAYS = 14;

/** Longer than this and the previous start is stale rather than current. */
const MAX_PLAUSIBLE = 60;

export interface CycleStatus {
  /** Day 1 is the first day of bleeding. Null when nothing is logged. */
  cycle_day: number | null;
  phase: Phase;
  last_period_start: string | null;
  /** Mean of her own recent cycles, or null when there are fewer than two. */
  mean_length: number | null;
  observed_cycles: number;
  /** The length actually used for the prediction, assumed or measured. */
  length_used: number;
  predicted_next_start: string | null;
  /** How much to trust the phase. */
  confidence: 'none' | 'assumed' | 'measured';
  /** Oura's nightly temperature deviation, when there is one. */
  temp_deviation: number | null;
  notes: string[];
}

export interface CycleRecord {
  day: string;
  length: number | null;
}

export async function logPeriodStart(db: Queryable, day: string = today(), note?: string): Promise<void> {
  await db.query(
    `INSERT INTO cycle_events (day, kind, note) VALUES ($1, 'period_start', $2)
     ON CONFLICT (day, kind) DO UPDATE SET note = EXCLUDED.note`,
    [day, note ?? null],
  );
}

export async function deletePeriodStart(db: Queryable, day: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM cycle_events WHERE day = $1 AND kind = 'period_start'`, [day]);
  return (rowCount ?? 0) > 0;
}

/** Every logged start, newest first, each with the length of the cycle it began. */
export async function listCycles(db: Queryable, limit = 12): Promise<CycleRecord[]> {
  const { rows } = await db.query(
    `SELECT day FROM cycle_events WHERE kind = 'period_start' ORDER BY day DESC LIMIT $1`,
    [limit],
  );
  const days = rows.map(r => dbDay(r.day));
  return days.map((day, i) => {
    const previous = days[i + 1];
    const length = previous ? daysBetween(previous, day) : null;
    return { day, length: length != null && length <= MAX_PLAUSIBLE ? length : null };
  });
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function phaseFor(cycleDay: number, length: number): Phase {
  const ovulation = Math.max(10, length - LUTEAL_DAYS);
  if (cycleDay <= 5) return 'менструальная';
  if (cycleDay < ovulation - 1) return 'фолликулярная';
  if (cycleDay <= ovulation + 1) return 'овуляторная';
  return 'лютеиновая';
}

export async function cycleStatus(db: Queryable, day: string = today()): Promise<CycleStatus> {
  const cycles = await listCycles(db, 12);
  const past = cycles.filter(c => c.day <= day);
  const last = past[0] ?? null;

  const lengths = cycles.map(c => c.length).filter((v): v is number => v != null && v >= 18 && v <= 45);
  const meanLength = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : null;
  const lengthUsed = meanLength ?? ASSUMED_LENGTH;

  const temp = await tempDeviation(db, day);
  const notes: string[] = [];

  if (!last) {
    notes.push('Начало цикла ещё не отмечено. Скажи боту «первый день цикла» — дальше он считает сам.');
    return {
      cycle_day: null,
      phase: 'неизвестно',
      last_period_start: null,
      mean_length: null,
      observed_cycles: 0,
      length_used: lengthUsed,
      predicted_next_start: null,
      confidence: 'none',
      temp_deviation: temp,
      notes,
    };
  }

  const cycleDay = daysBetween(last.day, day) + 1;
  if (cycleDay > MAX_PLAUSIBLE) {
    notes.push(
      `Последнее отмеченное начало — ${last.day}, это ${cycleDay} дн. назад. Похоже, пропущено: фазу не считаю.`,
    );
    return {
      cycle_day: null,
      phase: 'неизвестно',
      last_period_start: last.day,
      mean_length: meanLength,
      observed_cycles: lengths.length,
      length_used: lengthUsed,
      predicted_next_start: null,
      confidence: 'none',
      temp_deviation: temp,
      notes,
    };
  }

  const phase = phaseFor(cycleDay, lengthUsed);
  const confidence = meanLength != null ? 'measured' : 'assumed';

  if (confidence === 'assumed') {
    notes.push(`Длина цикла взята как ${ASSUMED_LENGTH} дн. — своих данных пока нет, нужно два отмеченных начала.`);
  } else {
    notes.push(`Длина цикла ${meanLength} дн. по ${lengths.length} собственным циклам.`);
  }

  if (phase === 'лютеиновая') {
    notes.push(
      'Лютеиновая фаза: вода задерживается, весы могут показывать на 1–2 кг больше при неизменном жире. ' +
        'Сравнивать вес имеет смысл с той же фазой прошлого цикла, а не с прошлой неделей.',
    );
  }
  if (temp != null && temp >= 0.2 && (phase === 'фолликулярная' || phase === 'менструальная')) {
    notes.push(
      `Температура по кольцу выше базы на ${temp.toFixed(2)} °C, что для этой фазы необычно — возможно, ` +
        'цикл сдвинулся, или это начало болезни.',
    );
  }

  return {
    cycle_day: cycleDay,
    phase,
    last_period_start: last.day,
    mean_length: meanLength,
    observed_cycles: lengths.length,
    length_used: lengthUsed,
    predicted_next_start: shiftDay(last.day, lengthUsed),
    confidence,
    temp_deviation: temp,
    notes,
  };
}

async function tempDeviation(db: Queryable, day: string): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT temp_deviation FROM daily_metrics WHERE day = $1 AND temp_deviation IS NOT NULL LIMIT 1`,
    [day],
  );
  return rows[0]?.temp_deviation == null ? null : Number(rows[0].temp_deviation);
}

/**
 * The phase of every day in a range, for reading other series through.
 * Days before the first logged period come back as unknown rather than guessed
 * backwards.
 */
export async function phasesByDay(db: Queryable, start: string, end: string): Promise<Map<string, Phase>> {
  const cycles = await listCycles(db, 24);
  const starts = cycles.map(c => c.day).sort();
  const lengths = cycles.map(c => c.length).filter((v): v is number => v != null && v >= 18 && v <= 45);
  const fallback = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : ASSUMED_LENGTH;

  const out = new Map<string, Phase>();
  for (let d = start; d <= end; d = shiftDay(d, 1)) {
    const begun = [...starts].reverse().find(s => s <= d);
    if (!begun) {
      out.set(d, 'неизвестно');
      continue;
    }
    const next = starts.find(s => s > begun);
    const length = next ? daysBetween(begun, next) : fallback;
    const cycleDay = daysBetween(begun, d) + 1;
    out.set(
      d,
      cycleDay > MAX_PLAUSIBLE ? 'неизвестно' : phaseFor(cycleDay, length >= 18 && length <= 45 ? length : fallback),
    );
  }
  return out;
}
