/**
 * "What should I eat?" — turns the day so far into two or three concrete
 * suggestions that fit what is left of the budget.
 *
 * Unlike the estimator this wants prose, not a tool call, so it asks for a
 * plain answer and hands back whatever came out.
 */
import { timezone } from './dates.js';
import type { DaySummary } from './service.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

export class SuggestError extends Error {}

const SYSTEM = [
  'You advise someone who is tracking a calorie budget to lose weight, in Israel, on what to eat',
  'next. You are given what is left of today and what has already been eaten.',
  '',
  'Answer in Russian. Give two or three concrete options, one line each: what it is, roughly how',
  'much of it, and its kcal and protein. Prefer things that need little or no cooking and that a',
  'supermarket here actually sells.',
  '',
  'Fit the options to what is actually short. Protein is almost always the gap and fat is almost',
  'always overspent, so lean protein does more good than a smaller portion of anything else. When',
  'the fat left is zero or negative, say so and keep the options lean. When the kcal left cannot',
  'cover the protein left, say which of the two to give up and by how much, rather than pretending',
  'both fit.',
  '',
  'When there is almost nothing left, say that stopping is the answer instead of inventing a snack.',
  '',
  'At most 80 words. No preamble, no sign-off, no markdown headings. Plain lines starting with "•".',
].join('\n');

function hhmm(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone(),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** The day, written out the way the model should see it. */
function describe(day: DaySummary): string {
  const r = day.remaining;
  const c = day.consumed;
  const eaten = day.meals.length
    ? day.meals.map(m => `  - ${m.description} (${m.kcal} kcal, protein ${m.protein_g} g)`).join('\n')
    : '  - nothing yet';
  const m = day.metrics;
  const ring = [
    m.active_kcal != null ? `active ${Math.round(m.active_kcal)} kcal` : null,
    m.workout_min ? `workout ${Math.round(m.workout_min)} min` : null,
    m.sleep_min != null ? `sleep ${Math.round(m.sleep_min)} min` : null,
    m.readiness != null ? `readiness ${Math.round(m.readiness)}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return [
    `Local time: ${hhmm(new Date())}`,
    `Budget today: ${day.budget.adjusted} kcal (base ${day.budget.base}, activity bonus ${day.budget.extra})`,
    `Eaten so far: ${c.kcal} kcal, protein ${c.protein_g} g, fat ${c.fat_g} g, carbs ${c.carbs_g} g`,
    `Left: ${r.kcal} kcal, protein ${r.protein_g} g, fat ${r.fat_g} g, carbs ${r.carbs_g} g`,
    ring ? `Wearables: ${ring}` : '',
    'Meals:',
    eaten,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function suggestFood(apiKey: string, day: DaySummary, ask?: string): Promise<string> {
  const question = ask?.trim() ? `\n\nThe person adds: ${ask.trim()}` : '';
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{ role: 'user', content: `${describe(day)}${question}` }],
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new SuggestError(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);

  const body = JSON.parse(text) as { content?: { type: string; text?: string }[] };
  const out = (body.content ?? [])
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!.trim())
    .join('\n')
    .trim();
  if (!out) throw new SuggestError('The model returned no suggestion');
  return out;
}
