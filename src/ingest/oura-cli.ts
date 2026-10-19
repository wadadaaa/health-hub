/** One-off backfill: `npm run ingest:oura -- 30` pulls the last 30 days. */
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';
import { setTimezone } from '../dates.js';
import { ingestOura } from './oura.js';

const config = loadConfig();
setTimezone(config.TZ_LOCAL);
if (!config.OURA_TOKEN) {
  console.error('OURA_TOKEN is not set');
  process.exit(1);
}
const days = Number(process.argv[2] ?? 7);
const pool = createPool(config.DATABASE_URL);
await migrate(pool);
const result = await ingestOura(pool, config.OURA_TOKEN, days);
console.log(JSON.stringify(result, null, 2));
await pool.end();
