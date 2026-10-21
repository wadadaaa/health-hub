/**
 * The bot's brain: one Claude conversation with tools over the same database
 * the MCP server exposes.
 *
 * The earlier design was a single forced tool call per message — fast, but it
 * could not be argued with. A photo became a number and that was the end of
 * it. Here the model keeps the last turns of the chat, may think before
 * answering, and can read the day, log, correct or delete a meal as part of
 * working out what to say, so "it was without the oil" or "same as yesterday"
 * mean something.
 */
import type { Queryable } from './db.js';
import { timezone, today } from './dates.js';
import {
  deleteMeal,
  getDay,
  getTargets,
  getWeek,
  listMeals,
  logMeal,
  logWeight,
  updateMeal,
  weightTrend,
} from './service.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

/** Room to think, then answer. Thinking is billed inside max_tokens. */
const MAX_TOKENS = 6000;
const THINKING_BUDGET = 3000;

/** How many stored turns to replay. Two days of ordinary use. */
const HISTORY_TURNS = 40;

/** Stops a wedged conversation from calling tools forever. */
const MAX_STEPS = 8;

export class AgentError extends Error {}

// ---------- content blocks ----------

export type Block = Record<string, unknown> & { type: string };
export interface Turn {
  role: 'user' | 'assistant';
  content: Block[];
}

// ---------- tools ----------

const day = {
  type: 'string',
  description: "Local calendar day 'YYYY-MM-DD'. Defaults to today.",
} as const;

const TOOLS = [
  {
    name: 'get_day',
    description:
      'The state of a day: budget, targets, what has been eaten, what is left, the logged meals with their ids, ' +
      'and the wearable metrics. Call this before answering anything about the budget — never do the arithmetic yourself.',
    input_schema: { type: 'object', properties: { day }, required: [] },
  },
  {
    name: 'log_meal',
    description:
      'Record a meal. Returns the stored row with its id, so it can be corrected later. Use eaten_at only when the ' +
      'meal was not eaten just now.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What was eaten, including the portion assumed.' },
        kcal: { type: 'number' },
        protein_g: { type: 'number' },
        fat_g: { type: 'number' },
        carbs_g: { type: 'number' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        eaten_at: { type: 'string', description: 'ISO 8601 with offset. Default: now.' },
      },
      required: ['description', 'kcal'],
    },
  },
  {
    name: 'update_meal',
    description:
      'Correct a meal already logged, by id. Only the fields given change. This is what a correction in conversation ' +
      'should become — do not log a second meal for the same food.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        description: { type: 'string' },
        kcal: { type: 'number' },
        protein_g: { type: 'number' },
        fat_g: { type: 'number' },
        carbs_g: { type: 'number' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_meal',
    description: 'Remove a logged meal by id.',
    input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'list_meals',
    description:
      'The meals logged on a day, with ids. Use this to find what an earlier meal actually was before repeating it.',
    input_schema: { type: 'object', properties: { day }, required: [] },
  },
  {
    name: 'get_week',
    description: 'Seven days of budgets, intake, protein and wearable metrics, plus the weight trend.',
    input_schema: { type: 'object', properties: { end: day }, required: [] },
  },
  {
    name: 'log_weight',
    description: 'Record a weigh-in in kilograms.',
    input_schema: {
      type: 'object',
      properties: { kg: { type: 'number' }, day },
      required: ['kg'],
    },
  },
  {
    name: 'weight_trend',
    description:
      'Weigh-ins with a 7-day rolling average and the week-on-week change. Judge progress by avg7 and delta_week, ' +
      'never by one weigh-in.',
    input_schema: { type: 'object', properties: { days: { type: 'number' } }, required: [] },
  },
  {
    name: 'get_targets',
    description: 'The calorie and macro targets in force, and the rule that turns activity into a bigger budget.',
    input_schema: { type: 'object', properties: { day }, required: [] },
  },
] as const;

async function runTool(db: Queryable, name: string, a: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_day':
      return getDay(db, (a.day as string) ?? today());
    case 'log_meal': {
      const meal = await logMeal(db, {
        description: String(a.description),
        kcal: Number(a.kcal),
        protein_g: Number(a.protein_g ?? 0),
        fat_g: Number(a.fat_g ?? 0),
        carbs_g: Number(a.carbs_g ?? 0),
        confidence: a.confidence as 'low' | 'medium' | 'high' | undefined,
        eaten_at: a.eaten_at ? new Date(String(a.eaten_at)) : undefined,
        source: 'telegram',
      });
      const d = await getDay(db, meal.day);
      return { meal, remaining: d.remaining, budget: d.budget };
    }
    case 'update_meal': {
      const meal = await updateMeal(db, Number(a.id), a);
      if (!meal) return { error: `no meal with id ${a.id}` };
      const d = await getDay(db, meal.day);
      return { meal, remaining: d.remaining };
    }
    case 'delete_meal':
      return { deleted: await deleteMeal(db, Number(a.id)) };
    case 'list_meals':
      return { meals: await listMeals(db, (a.day as string) ?? today()) };
    case 'get_week':
      return getWeek(db, (a.end as string) ?? today());
    case 'log_weight': {
      const w = await logWeight(db, Number(a.kg), new Date(), 'telegram');
      return { weight: w, trend: await weightTrend(db) };
    }
    case 'weight_trend':
      return weightTrend(db, Number(a.days ?? 28));
    case 'get_targets':
      return getTargets(db, (a.day as string) ?? today());
    default:
      return { error: `unknown tool ${name}` };
  }
}

// ---------- the prompt ----------

function system(): string {
  return [
    'You are the health-hub bot in a private Telegram chat with one person, who is tracking a calorie budget to lose',
    `weight. Today is ${today()} (${timezone()}). Answer in Russian, briefly — this is read on a phone.`,
    '',
    'WHAT YOU DO',
    'A photo of food, or a sentence about one, is a meal to log: work out what it is, estimate it, and call log_meal.',
    'A question is a question — answer it and log nothing. A correction of something already logged is update_meal on',
    'that id, never a second meal. You have the conversation so far: use it. "Как вчера" means look up yesterday with',
    'list_meals rather than guessing, and "без масла" means fix the estimate you just made.',
    '',
    'ESTIMATING',
    'Estimate at the upper-middle of the plausible range: under-counting is the costly error on a deficit. Assume',
    'restaurant portions and normal cooking fat unless told otherwise.',
    '',
    'Count everything that is there, not just the dish it is named after. Go through the plate component by component',
    'and add each one: dressing, sauce, mayonnaise, cooking oil, butter, cheese, cream, granola, nuts, seeds, syrup,',
    'honey, chocolate, icing sugar, crispy onions, croutons, a side of bread, a dipping cup. These routinely carry more',
    'energy than the base they sit on, and leaving them out is the most common way this goes wrong.',
    '',
    'A nutrition label visible on a package describes the package only. Anything added to it — granola on a yogurt,',
    'fruit in a bowl, a drizzle on top — is counted on top of the label figures, not instead of them.',
    '',
    'Bakery and pastry are denser than they look: laminated dough is roughly a third butter by weight, and a cream-',
    'topped pastry is usually 600-900 kcal rather than 400. Judge portions against whatever is in frame for scale.',
    '',
    'When the person names the dish from a menu, trust the menu over the look of the photo: a stew is not fried, and a',
    'named grain is not the one you guessed.',
    '',
    'ADVICE',
    'When asked what to eat, call get_day first and fit the answer to what is actually short. Protein is almost always',
    'the gap and fat almost always overspent, so lean protein does more good than a smaller portion of anything else.',
    'Two or three concrete options with their kcal and protein, things a supermarket in Israel sells and that need',
    'little cooking. When the kcal left cannot cover the protein left, say which to give up and by how much instead of',
    'pretending both fit. When almost nothing is left, say that stopping is the answer.',
    '',
    'HOW TO WRITE',
    'Russian, and short — a few lines. Telegram HTML only: <b>, <i>, <code>. No markdown, no headings, no tables.',
    'After logging or changing a meal, give the numbers and what is left for the day. Do not round down to be kind and',
    'do not cheer. Say when an estimate is shaky and what would sharpen it.',
  ].join('\n');
}

// ---------- the loop ----------

export interface AgentDeps {
  db: Queryable;
  apiKey: string;
  chatId: string;
}

interface ApiResponse {
  content?: Block[];
  stop_reason?: string;
}

async function callApi(apiKey: string, messages: Turn[]): Promise<ApiResponse> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
      system: system(),
      tools: TOOLS,
      messages,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new AgentError(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as ApiResponse;
}

/**
 * Runs one user turn to completion and returns what to send back.
 *
 * History is loaded before and saved after, so a failure mid-flight leaves the
 * stored conversation as it was rather than half a tool call the next turn
 * would have to explain.
 */
export async function respond(deps: AgentDeps, userContent: Block[]): Promise<string> {
  const { db, apiKey, chatId } = deps;
  const history = await loadHistory(db, chatId);
  const messages: Turn[] = [...history, { role: 'user', content: userContent }];

  let reply = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await callApi(apiKey, messages);
    const content = res.content ?? [];
    // The assistant turn goes back verbatim, thinking blocks included: the API
    // rejects a tool result whose thinking has been stripped.
    messages.push({ role: 'assistant', content });

    const calls = content.filter(b => b.type === 'tool_use');
    if (!calls.length) {
      reply = content
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => String(b.text).trim())
        .join('\n')
        .trim();
      break;
    }

    const results: Block[] = [];
    for (const c of calls) {
      let out: unknown;
      try {
        out = await runTool(db, String(c.name), (c.input ?? {}) as Record<string, unknown>);
      } catch (e) {
        out = { error: e instanceof Error ? e.message : String(e) };
      }
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }

  if (!reply) throw new AgentError('Не получилось собрать ответ');

  // Store only the two ends of the turn. The tool traffic in between is
  // reproducible from the database and would crowd out older turns.
  await saveTurn(db, chatId, 'user', userContent);
  await saveTurn(db, chatId, 'assistant', [{ type: 'text', text: reply }]);
  return reply;
}

// ---------- history ----------

/** Photos are dropped on the way in: their bytes are not ours to keep. */
function storable(content: Block[]): Block[] {
  const kept = content.map(b =>
    b.type === 'image' ? { type: 'text', text: '[фото еды]' } : b,
  );
  return kept.length ? kept : [{ type: 'text', text: '[пусто]' }];
}

export async function saveTurn(db: Queryable, chatId: string, role: 'user' | 'assistant', content: Block[]) {
  await db.query('INSERT INTO chat_messages (chat_id, role, content) VALUES ($1, $2, $3)', [
    chatId,
    role,
    JSON.stringify(storable(content)),
  ]);
}

export async function loadHistory(db: Queryable, chatId: string): Promise<Turn[]> {
  const { rows } = await db.query<{ role: 'user' | 'assistant'; content: unknown }>(
    'SELECT role, content FROM chat_messages WHERE chat_id = $1 ORDER BY id DESC LIMIT $2',
    [chatId, HISTORY_TURNS],
  );
  const turns = rows
    .reverse()
    .map(r => ({
      role: r.role,
      content: (typeof r.content === 'string' ? JSON.parse(r.content) : r.content) as Block[],
    }))
    .filter(t => t.content.length > 0);
  // The API wants the replay to start with the user.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

export async function forgetHistory(db: Queryable, chatId: string): Promise<void> {
  await db.query('DELETE FROM chat_messages WHERE chat_id = $1', [chatId]);
}
