/**
 * What the bot keeps between conversations.
 *
 * Three things live here, and they are different in kind:
 *
 *   facts        — durable sentences about the person. Written deliberately,
 *                  read into every turn.
 *   recall       — past meals that resemble the one in front of it, so a dish
 *                  eaten five times is priced from its own history.
 *   calibration  — what the corrections say about which foods the estimate
 *                  systematically under-reads.
 *
 * None of this is the model learning. The weights never move. It is the
 * database remembering on the model's behalf, which is the only kind of
 * learning available here and, for repeated meals, the useful kind.
 */
import type { Queryable } from './db.js';
import { dbDay, shiftDay, today } from './dates.js';

// ---------- facts ----------

export interface Fact {
  key: string;
  value: string;
  updated_at: string;
}

/** Enough to be useful, few enough to re-read every turn without thinking about it. */
const MAX_FACTS = 60;

export async function listFacts(db: Queryable): Promise<Fact[]> {
  const { rows } = await db.query(
    `SELECT key, value, updated_at FROM facts ORDER BY key ASC LIMIT ${MAX_FACTS}`,
  );
  return rows.map(r => ({
    key: String(r.key),
    value: String(r.value),
    updated_at: new Date(r.updated_at as string).toISOString(),
  }));
}

export async function remember(db: Queryable, key: string, value: string): Promise<Fact> {
  const k = key.trim().slice(0, 80);
  const v = value.trim().slice(0, 400);
  if (!k || !v) throw new Error('a fact needs both a key and a value');
  await db.query(
    `INSERT INTO facts (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [k, v],
  );
  return { key: k, value: v, updated_at: new Date().toISOString() };
}

export async function forget(db: Queryable, key: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM facts WHERE key = $1', [key.trim()]);
  return (rowCount ?? 0) > 0;
}

// ---------- the food dictionary ----------

export interface RecalledMeal {
  id: number;
  day: string;
  description: string;
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  times_seen: number;
  score: number;
}

/** Words too common in a food description to tell two dishes apart. */
const STOP = new Set([
  'с', 'и', 'в', 'на', 'из', 'без', 'по', 'до', 'от', 'за', 'г', 'гр', 'мл', 'шт', 'порция',
  'with', 'and', 'the', 'of', 'a', 'in', 'g', 'ml',
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(w => w.length > 2 && !STOP.has(w));
}

/**
 * Past meals resembling a description, scored by word overlap.
 *
 * Deliberately done in JS over a bounded window rather than with a trigram
 * index: the corpus is one person's meals, the window is months, and keeping
 * it out of SQL keeps the in-memory test database honest.
 */
export async function recallMeals(
  db: Queryable,
  query: string,
  limit = 5,
  withinDays = 180,
  endDay: string = today(),
): Promise<RecalledMeal[]> {
  const want = tokens(query);
  if (!want.length) return [];

  const { rows } = await db.query(
    `SELECT id, day, description, kcal, protein_g, fat_g, carbs_g
       FROM meals WHERE day >= $1 AND day <= $2
       ORDER BY day DESC, id DESC LIMIT 600`,
    [shiftDay(endDay, -withinDays), endDay],
  );

  const scored = rows
    .map(r => {
      const have = new Set(tokens(String(r.description)));
      const hits = want.filter(w => have.has(w)).length;
      // Jaccard-ish: reward overlap, punish a description that matched only
      // because it is long enough to contain everything.
      const score = hits === 0 ? 0 : hits / (want.length + have.size - hits);
      return {
        id: Number(r.id),
        day: dbDay(r.day),
        description: String(r.description),
        kcal: Number(r.kcal),
        protein_g: Number(r.protein_g),
        fat_g: Number(r.fat_g),
        carbs_g: Number(r.carbs_g),
        score: Math.round(score * 100) / 100,
      };
    })
    .filter(m => m.score > 0.12)
    .sort((a, b) => b.score - a.score);

  // Collapse the same dish eaten repeatedly into one line with a count, which
  // is what makes the answer short enough to be worth reading.
  const seen = new Map<string, RecalledMeal>();
  for (const m of scored) {
    const key = tokens(m.description).sort().join(' ');
    const prev = seen.get(key);
    if (prev) {
      prev.times_seen += 1;
      continue;
    }
    seen.set(key, { ...m, times_seen: 1 });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

// ---------- the correction log ----------

export type Category =
  | 'выпечка и десерты'
  | 'салаты'
  | 'мясо и рыба'
  | 'крупы и паста'
  | 'напитки'
  | 'молочное'
  | 'прочее';

const CATEGORY_WORDS: [Category, RegExp][] = [
  [
    'выпечка и десерты',
    /круассан|пирож|торт|булоч|кекс|маффин|печен|десерт|крем|шоколад|мороже|пахлав|штрудель|круас|бурек|пончик|вафл|блин|сырник|pastry|croissant|cake|cookie|dessert|kouign|danish/i,
  ],
  ['салаты', /салат|цезар|нисуаз|боул|bowl|salad|caesar|овощ|тахин|хумус/i],
  ['напитки', /кофе|латте|капучин|чай|сок|смузи|пиво|вино|coffee|latte|tea|juice|smoothie|beer|wine/i],
  ['мясо и рыба', /курин|курица|грудк|говяд|индейк|рыб|лосос|тунц|тунец|шницел|котлет|стейк|кебаб|шаурм|фалафел|яйц|chicken|beef|fish|salmon|tuna|steak/i],
  ['крупы и паста', /паст|рис|булгур|кускус|гречк|овсян|каш|хлеб|питa|пита|лаваш|сэндвич|бурито|пицц|rice|pasta|bread|oat|bulgur/i],
  ['молочное', /йогурт|творог|сыр|кефир|молок|yogurt|cottage|cheese|milk/i],
];

/** A crude bucket, but a stable one: the point is grouping, not taxonomy. */
export function categorise(description: string): Category {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(description)) return cat;
  return 'прочее';
}

export interface CorrectionInput {
  meal_id: number;
  day: string;
  description: string;
  before: { kcal: number; protein_g: number; fat_g: number; carbs_g: number };
  after: { kcal: number; protein_g: number; fat_g: number; carbs_g: number };
}

export async function recordCorrection(db: Queryable, c: CorrectionInput): Promise<void> {
  // Only energy changes are worth a row; a reworded description is not a
  // correction of the estimate.
  if (Math.round(c.before.kcal) === Math.round(c.after.kcal)) return;
  await db.query(
    `INSERT INTO meal_corrections
       (meal_id, day, category, description, before_kcal, after_kcal,
        before_protein_g, after_protein_g, before_fat_g, after_fat_g, before_carbs_g, after_carbs_g)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      c.meal_id,
      c.day,
      categorise(c.description),
      c.description.slice(0, 300),
      Math.round(c.before.kcal),
      Math.round(c.after.kcal),
      c.before.protein_g,
      c.after.protein_g,
      c.before.fat_g,
      c.after.fat_g,
      c.before.carbs_g,
      c.after.carbs_g,
    ],
  );
}

export interface CategoryBias {
  category: Category;
  n: number;
  /** Median after/before. Above 1 means the first estimate ran low. */
  median_ratio: number;
  median_kcal_delta: number;
  /** True once there are enough corrections for the number to mean anything. */
  reportable: boolean;
}

/** Under this, a ratio is one bad lunch, not a pattern. */
const MIN_CORRECTIONS = 8;

export async function calibration(db: Queryable): Promise<{ categories: CategoryBias[]; total: number }> {
  const { rows } = await db.query(
    'SELECT category, before_kcal, after_kcal FROM meal_corrections ORDER BY id DESC LIMIT 500',
  );
  const byCat = new Map<string, { ratios: number[]; deltas: number[] }>();
  for (const r of rows) {
    const before = Number(r.before_kcal);
    const after = Number(r.after_kcal);
    if (!(before > 0)) continue;
    const g = byCat.get(String(r.category)) ?? { ratios: [], deltas: [] };
    g.ratios.push(after / before);
    g.deltas.push(after - before);
    byCat.set(String(r.category), g);
  }
  const categories = [...byCat.entries()]
    .map(([category, g]) => ({
      category: category as Category,
      n: g.ratios.length,
      median_ratio: Math.round(median(g.ratios) * 100) / 100,
      median_kcal_delta: Math.round(median(g.deltas)),
      reportable: g.ratios.length >= MIN_CORRECTIONS,
    }))
    .sort((a, b) => b.n - a.n);
  return { categories, total: rows.length };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The part of the system prompt that changes as the database learns: the
 * standing facts, and the categories where the estimate is known to run low.
 * Returns an empty string when there is nothing earned yet — an empty
 * "what we know about you" section is worse than none.
 */
export async function learnedPrompt(db: Queryable): Promise<string> {
  const [facts, cal] = await Promise.all([listFacts(db), calibration(db)]);
  const parts: string[] = [];

  if (facts.length) {
    parts.push(
      'WHAT YOU KNOW ABOUT HER (kept between conversations; use it, and call remember when she tells you something new and lasting):',
      ...facts.map(f => `- ${f.key}: ${f.value}`),
    );
  }

  const biased = cal.categories.filter(c => c.reportable && Math.abs(c.median_ratio - 1) >= 0.12);
  if (biased.length) {
    parts.push(
      '',
      'YOUR OWN TRACK RECORD on her corrections. These are measured, not guessed, so lean on them:',
      ...biased.map(
        c =>
          `- ${c.category}: your first estimate was corrected by ×${c.median_ratio} (median of ${c.n}). ` +
          `${c.median_ratio > 1 ? 'You read this kind of food low — start higher.' : 'You read this kind of food high.'}`,
      ),
    );
  }

  return parts.join('\n');
}
