/**
 * Startup state, kept so the process survives a database that is not up yet.
 *
 * The container restarts on crash and re-clones the source each time, so an
 * app that exits on a failed migration turns one slow Postgres into a restart
 * loop that serves 502 and leaves nothing to read. Instead the HTTP server
 * listens immediately, the database work retries in the background, and
 * /healthz reports what is wrong.
 */
export type Phase = 'starting' | 'ready' | 'failing';

export interface Readiness {
  phase: Phase;
  since: number;
  attempts: number;
  lastError: string | null;
  migrations: string[];
}

export function createReadiness(): Readiness {
  return { phase: 'starting', since: Date.now(), attempts: 0, lastError: null, migrations: [] };
}

export interface RetryOptions {
  /** Give up waiting for the first success after this long; 0 retries forever. */
  firstAttemptAt?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Runs `work` until it succeeds, backing off between attempts and recording
 * each failure on `state`. Never throws: a caller that cannot proceed is
 * expected to read `state.phase`.
 */
export async function keepTrying(
  state: Readiness,
  work: () => Promise<string[]>,
  { minDelayMs = 1000, maxDelayMs = 30_000 }: RetryOptions = {},
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
): Promise<void> {
  let delay = minDelayMs;
  for (;;) {
    state.attempts += 1;
    try {
      state.migrations = await work();
      state.phase = 'ready';
      state.since = Date.now();
      state.lastError = null;
      return;
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      if (state.phase !== 'failing') {
        state.phase = 'failing';
        state.since = Date.now();
      }
      console.error(`[startup] attempt ${state.attempts} failed: ${state.lastError}`);
      await sleep(delay);
      delay = Math.min(maxDelayMs, delay * 2);
    }
  }
}
