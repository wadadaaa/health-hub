/** One-off backfill: `node dist/ingest/oura-cli.js 30` pulls the last 30 days. */
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';
import { setTimezone } from '../dates.js';
import { getAccessToken, type OuraOAuthConfig } from '../oura-auth.js';
import { ingestOura, type TokenSource } from './oura.js';

const config = loadConfig();
setTimezone(config.TZ_LOCAL);

const pool = createPool(config.DATABASE_URL);
await migrate(pool);

const oauth: OuraOAuthConfig | null =
  config.OURA_CLIENT_ID && config.OURA_CLIENT_SECRET && config.PUBLIC_URL
    ? {
        clientId: config.OURA_CLIENT_ID,
        clientSecret: config.OURA_CLIENT_SECRET,
        redirectUri: `${config.PUBLIC_URL.replace(/\/+$/, '')}/oura/callback`,
      }
    : null;

const source: TokenSource | null = oauth ? () => getAccessToken(pool, oauth) : (config.OURA_TOKEN ?? null);
if (!source) {
  console.error('Oura is not configured');
  process.exit(1);
}

const days = Number(process.argv[2] ?? 7);
console.log(JSON.stringify(await ingestOura(pool, source, days), null, 2));
await pool.end();
