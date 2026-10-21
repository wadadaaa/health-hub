/**
 * Turning a photo or a sentence about food into calories and macros, with
 * Claude. The model is asked for one tool call so the result is structured
 * rather than parsed out of prose.
 */
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

export interface MealEstimate {
  description: string;
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  confidence: 'low' | 'medium' | 'high';
  note?: string;
}

const TOOL = {
  name: 'log_meal',
  description: 'Record one meal with its estimated energy and macronutrients.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'What the meal is, in the language the user wrote in, naming the main components and the portion assumed.',
      },
      kcal: { type: 'number', description: 'Total energy in kilocalories.' },
      protein_g: { type: 'number' },
      fat_g: { type: 'number' },
      carbs_g: { type: 'number' },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'How well the portion and ingredients can actually be judged from what was given.',
      },
      note: {
        type: 'string',
        description:
          'At most one short sentence: the assumption that most affects the number, or what to tell us to sharpen it. Omit when there is nothing useful to say.',
      },
    },
    required: ['description', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'confidence'],
  },
} as const;

const SYSTEM = [
  'You estimate the energy and macronutrients of a meal for someone tracking a calorie budget.',
  '',
  'Estimate at the upper-middle of the plausible range: for weight loss, under-counting is the',
  'costly error. Assume restaurant portions and normal cooking fat unless told otherwise.',
  '',
  'Count everything that is there, not just the dish it is named after. Work through the plate',
  'component by component and add each one: dressing, sauce, mayonnaise, cooking oil, butter,',
  'cheese, cream, granola, nuts, seeds, syrup, honey, chocolate, icing sugar, croutons, a side of',
  'bread. These toppings and add-ons routinely carry more energy than the base they sit on, and',
  'leaving them out is the single most common way this estimate goes wrong.',
  '',
  'A nutrition label visible on a package describes only the packaged product. Anything added to',
  'it — granola on a yogurt, fruit in a bowl, a drizzle on top — is extra and must be added to the',
  'label figures, not used in place of them. Say in the description what was added and how much',
  'you assumed.',
  '',
  'Bakery and pastry are denser than they look. Laminated dough (croissant, kouign-amann, danish,',
  'puff pastry) is roughly a third butter by weight; whipped cream, diplomat and pastry cream',
  'domes add a few hundred kilocalories on their own. A large filled or topped pastry is usually',
  '600-900 kcal, not 400.',
  '',
  'Judge portion size against whatever is in frame for scale — cutlery, a hand, the container,',
  'the tray. When a photo shows no scale at all, assume the larger end of the usual range.',
  '',
  'Call log_meal exactly once. Write the description in the same language the user used.',
].join('\n');

export class EstimateError extends Error {}

interface ContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

async function callClaude(apiKey: string, content: unknown[]): Promise<MealEstimate> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'log_meal' },
      messages: [{ role: 'user', content }],
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new EstimateError(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);

  const body = JSON.parse(text) as { content?: ContentBlock[] };
  const call = body.content?.find(b => b.type === 'tool_use' && b.name === 'log_meal');
  if (!call?.input) throw new EstimateError('The model returned no estimate');

  const i = call.input as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    description: String(i.description ?? 'meal'),
    kcal: Math.max(0, Math.round(num(i.kcal))),
    protein_g: Math.max(0, num(i.protein_g)),
    fat_g: Math.max(0, num(i.fat_g)),
    carbs_g: Math.max(0, num(i.carbs_g)),
    confidence: i.confidence === 'high' || i.confidence === 'low' ? i.confidence : 'medium',
    note: typeof i.note === 'string' && i.note.trim() ? i.note.trim() : undefined,
  };
}

export async function estimateFromPhoto(
  apiKey: string,
  image: { base64: string; mediaType: string },
  caption?: string,
): Promise<MealEstimate> {
  return callClaude(apiKey, [
    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
    {
      type: 'text',
      text: caption?.trim()
        ? `What is in this meal? The person adds: ${caption.trim()}`
        : 'What is in this meal, and what does it come to?',
    },
  ]);
}

export async function estimateFromText(apiKey: string, text: string): Promise<MealEstimate> {
  return callClaude(apiKey, [{ type: 'text', text: `The person ate: ${text}` }]);
}
