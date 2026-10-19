import cron from 'node-cron';
import type { Queryable } from './db.js';
import { ingestOura } from './ingest/oura.js';

export function startOuraCron(db: Queryable, token: string, expression: string, backfillDays: number, tz: string) {
  if (!cron.validate(expression)) throw new Error(`Invalid OURA_CRON: ${expression}`);
  const run = async () => {
    try {
      const r = await ingestOura(db, token, backfillDays);
      console.log(`[oura] synced ${r.days.length} day(s): ${r.days.join(', ') || '-'}`);
    } catch (e) {
      console.error('[oura] sync failed:', e instanceof Error ? e.message : e);
    }
  };
  const task = cron.schedule(expression, run, { timezone: tz });
  void run(); // sync once at boot so a fresh deploy has data immediately
  return task;
}
