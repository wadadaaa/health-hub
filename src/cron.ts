import cron from 'node-cron';
import { composeBriefing } from './briefing.js';
import type { Queryable } from './db.js';
import { ingestOura, type TokenSource } from './ingest/oura.js';
import { getSetting } from './settings.js';
import { sendMessage } from './telegram.js';

export function startOuraCron(
  db: Queryable,
  tokenSource: TokenSource,
  expression: string,
  backfillDays: number,
  tz: string,
) {
  if (!cron.validate(expression)) throw new Error(`Invalid OURA_CRON: ${expression}`);
  const run = async () => {
    try {
      const r = await ingestOura(db, tokenSource, backfillDays);
      console.log(`[oura] synced ${r.days.length} day(s): ${r.days.join(', ') || '-'}`);
    } catch (e) {
      console.error('[oura] sync failed:', e instanceof Error ? e.message : e);
    }
  };
  const task = cron.schedule(expression, run, { timezone: tz });
  void run(); // sync once at boot so a fresh deploy has data immediately
  return task;
}

/**
 * The morning briefing. Silent when the bot is not paired yet, and a failure
 * here must never take the process with it — it is a nicety, not the service.
 */
export function startBriefingCron(db: Queryable, expression: string, tz: string) {
  if (!cron.validate(expression)) throw new Error(`Invalid BRIEFING_CRON: ${expression}`);
  const run = async () => {
    try {
      const [token, chatId] = await Promise.all([
        getSetting(db, 'telegram_bot_token'),
        getSetting(db, 'telegram_chat_id'),
      ]);
      if (!token || !chatId) return;
      await sendMessage(token, Number(chatId), await composeBriefing(db));
      console.log('[briefing] sent');
    } catch (e) {
      console.error('[briefing] failed:', e instanceof Error ? e.message : e);
    }
  };
  return cron.schedule(expression, run, { timezone: tz });
}
