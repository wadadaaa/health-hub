import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Queryable } from './db.js';
import { isDay, today } from './dates.js';
import {
  deleteMeal,
  getDay,
  getTargets,
  getWeek,
  logMeal,
  logWeight,
  setTargets,
  updateMeal,
  weightTrend,
} from './service.js';
import { ingestOura, type TokenSource } from './ingest/oura.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

const dayArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Local calendar day 'YYYY-MM-DD'. Defaults to today (Asia/Jerusalem).");

export interface McpDeps {
  db: Queryable;
  /** A static token or a refreshing provider; null when Oura is unconfigured. */
  ouraTokenSource?: TokenSource | null;
}

/**
 * One McpServer per request (stateless Streamable HTTP). Cheap: tool registration only.
 * Tool descriptions are written for the model that calls them (Claude in claude.ai / Claude Code / a bot).
 */
export function createMcpServer({ db, ouraTokenSource }: McpDeps): McpServer {
  const server = new McpServer({ name: 'health-hub', version: '0.1.0' });

  server.registerTool(
    'log_meal',
    {
      title: 'Log a meal',
      description:
        'Record a meal (usually estimated from a photo) into the daily log. Returns the stored row including its id, ' +
        'so it can be corrected later with update_meal. Use eaten_at only when the meal was not eaten just now.',
      inputSchema: {
        description: z.string().min(1).describe('Short description of what was eaten, incl. portion assumptions'),
        kcal: z.number().min(0),
        protein_g: z.number().min(0).default(0),
        fat_g: z.number().min(0).default(0),
        carbs_g: z.number().min(0).default(0),
        confidence: z.enum(['low', 'medium', 'high']).optional().describe('Estimate quality'),
        eaten_at: z.string().datetime({ offset: true }).optional().describe('ISO 8601 with offset; default now'),
      },
    },
    async (a) => {
      const meal = await logMeal(db, {
        ...a,
        eaten_at: a.eaten_at ? new Date(a.eaten_at) : undefined,
      });
      const day = await getDay(db, meal.day);
      return json({ meal, remaining: day.remaining, budget: day.budget.adjusted });
    },
  );

  server.registerTool(
    'update_meal',
    {
      title: 'Update a logged meal',
      description: 'Correct a previously logged meal (e.g. after learning the dressing or portion size). Only given fields change.',
      inputSchema: {
        id: z.number().int().positive(),
        description: z.string().min(1).optional(),
        kcal: z.number().min(0).optional(),
        protein_g: z.number().min(0).optional(),
        fat_g: z.number().min(0).optional(),
        carbs_g: z.number().min(0).optional(),
        confidence: z.enum(['low', 'medium', 'high']).optional(),
        eaten_at: z.string().datetime({ offset: true }).optional(),
      },
    },
    async ({ id, eaten_at, ...patch }) => {
      const meal = await updateMeal(db, id, { ...patch, eaten_at: eaten_at ? new Date(eaten_at) : undefined });
      if (!meal) return json({ error: `meal ${id} not found` });
      const day = await getDay(db, meal.day);
      return json({ meal, remaining: day.remaining });
    },
  );

  server.registerTool(
    'delete_meal',
    {
      title: 'Delete a logged meal',
      description: 'Remove a meal that was logged by mistake.',
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => json({ deleted: await deleteMeal(db, id), id }),
  );

  server.registerTool(
    'get_day',
    {
      title: 'Daily summary',
      description:
        'Budget, consumed, remaining macros, the meal list and wearable metrics (active kcal, steps, sleep, readiness) for one day. ' +
        'Call this before estimating the next meal so advice reflects what is already eaten and how active the day was.',
      inputSchema: { day: dayArg },
    },
    async ({ day }) => json(await getDay(db, day ?? today())),
  );

  server.registerTool(
    'get_week',
    {
      title: 'Weekly summary',
      description: 'Seven days ending on `end` (default today): per-day budget vs consumed, averages, and the 28-day weight trend.',
      inputSchema: { end: dayArg },
    },
    async ({ end }) => json(await getWeek(db, end ?? today())),
  );

  server.registerTool(
    'log_weight',
    {
      title: 'Log body weight',
      description: 'Record a weigh-in in kg. Use measured_at when it was not just now.',
      inputSchema: {
        kg: z.number().min(20).max(300),
        measured_at: z.string().datetime({ offset: true }).optional(),
      },
    },
    async ({ kg, measured_at }) => {
      const w = await logWeight(db, kg, measured_at ? new Date(measured_at) : new Date(), 'manual');
      return json({ weight: w, trend: await weightTrend(db, 28) });
    },
  );

  server.registerTool(
    'weight_trend',
    {
      title: 'Weight trend',
      description:
        'Daily weights with a 7-day rolling average over the last N days (default 28). Judge progress by avg7 and delta_week, not single weigh-ins.',
      inputSchema: { days: z.number().int().min(7).max(365).default(28) },
    },
    async ({ days }) => json(await weightTrend(db, days)),
  );

  server.registerTool(
    'get_targets',
    {
      title: 'Current targets',
      description: 'Base calorie/macro targets and the activity-adjustment rule in force for a day (default today).',
      inputSchema: { day: dayArg },
    },
    async ({ day }) => json(await getTargets(db, day ?? today())),
  );

  server.registerTool(
    'set_targets',
    {
      title: 'Set new targets',
      description:
        'Create a new targets version valid from `valid_from` (default today). Previous versions stay for history. ' +
        'Daily budget = kcal + active_factor × max(0, active_kcal − active_baseline), never below min_kcal.',
      inputSchema: {
        kcal: z.number().int().min(1000).max(5000),
        protein_g: z.number().int().min(0),
        fat_g: z.number().int().min(0),
        carbs_g: z.number().int().min(0),
        active_factor: z.number().min(0).max(1).optional().describe('Share of extra active kcal added to budget (default keeps current, initially 0.6)'),
        active_baseline: z.number().int().min(0).optional().describe('Active kcal of a normal office day already assumed in base kcal (initially 300)'),
        min_kcal: z.number().int().min(800).optional(),
        valid_from: dayArg,
        note: z.string().optional(),
      },
    },
    async (a) => json(await setTargets(db, a)),
  );

  server.registerTool(
    'sync_oura',
    {
      title: 'Sync Oura now',
      description: 'Pull the last N days from the Oura API into daily metrics (also runs on a schedule). Requires Oura to be connected on the server.',
      inputSchema: { days: z.number().int().min(1).max(30).default(3) },
    },
    async ({ days }) => {
      if (!ouraTokenSource) return json({ error: 'Oura is not configured on the server' });
      return json(await ingestOura(db, ouraTokenSource, days));
    },
  );

  return server;
}

export { isDay };
