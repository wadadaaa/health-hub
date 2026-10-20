/**
 * Settings read from the database, falling back to the environment.
 *
 * Values are cached briefly so a per-request read does not become a query per
 * request; a write clears the cache so a change takes effect immediately.
 */
import type { Queryable } from './db.js';

export type SettingKey =
  | 'telegram_bot_token'
  | 'telegram_webhook_secret'
  | 'telegram_chat_id'
  | 'anthropic_api_key';

/** Env var consulted when a key has no row. */
const ENV_FALLBACK: Record<SettingKey, string> = {
  telegram_bot_token: 'TELEGRAM_BOT_TOKEN',
  telegram_webhook_secret: 'TELEGRAM_WEBHOOK_SECRET',
  telegram_chat_id: 'TELEGRAM_CHAT_ID',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
};

/** Keys whose value is never returned by the API. */
export const SECRET_KEYS = new Set<SettingKey>([
  'telegram_bot_token',
  'telegram_webhook_secret',
  'anthropic_api_key',
]);

const CACHE_TTL_MS = 5_000;
let cache: { at: number; values: Map<string, string> } | null = null;

async function load(db: Queryable): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;
  const { rows } = await db.query('SELECT key, value FROM settings');
  const values = new Map(rows.map(r => [String(r.key), String(r.value)]));
  cache = { at: Date.now(), values };
  return values;
}

export function invalidate(): void {
  cache = null;
}

export async function getSetting(db: Queryable, key: SettingKey): Promise<string | null> {
  const stored = (await load(db)).get(key);
  if (stored) return stored;
  const fromEnv = process.env[ENV_FALLBACK[key]];
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

export async function setSetting(db: Queryable, key: SettingKey, value: string): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
  invalidate();
}

export async function deleteSetting(db: Queryable, key: SettingKey): Promise<void> {
  await db.query('DELETE FROM settings WHERE key = $1', [key]);
  invalidate();
}

export interface SettingsView {
  [key: string]: { set: boolean; value?: string; source: 'database' | 'environment' | 'unset' };
}

/** What the API reports: secrets as set/unset, everything else in full. */
export async function describeSettings(db: Queryable): Promise<SettingsView> {
  const stored = await load(db);
  const out: SettingsView = {};
  for (const key of Object.keys(ENV_FALLBACK) as SettingKey[]) {
    const inDb = stored.get(key);
    const inEnv = process.env[ENV_FALLBACK[key]];
    const value = inDb ?? (inEnv && inEnv.length > 0 ? inEnv : undefined);
    const source = inDb ? 'database' : value ? 'environment' : 'unset';
    out[key] = SECRET_KEYS.has(key)
      ? { set: value !== undefined, source }
      : { set: value !== undefined, value, source };
  }
  return out;
}
