import { loadConfig } from './config.js';
import { startOuraCron } from './cron.js';
import { createPool, migrate } from './db.js';
import { setTimezone } from './dates.js';
import { createApp } from './http.js';

const config = loadConfig();
setTimezone(config.TZ_LOCAL);

const pool = createPool(config.DATABASE_URL);
const ran = await migrate(pool);
if (ran.length) console.log(`[db] applied migrations: ${ran.join(', ')}`);

const app = createApp({ db: pool, config });
const server = app.listen(config.PORT, () => {
  console.log(`[http] listening on :${config.PORT}`);
  console.log(`[mcp] POST /mcp/<MCP_PATH_SECRET>  (claude.ai custom connector)`);
  console.log(`[mcp] POST /mcp  with Bearer API_TOKEN  (Claude Code, bots)`);
});

if (config.OURA_TOKEN) {
  startOuraCron(pool, config.OURA_TOKEN, config.OURA_CRON, config.OURA_BACKFILL_DAYS, config.TZ_LOCAL);
  console.log(`[oura] cron "${config.OURA_CRON}" (${config.TZ_LOCAL})`);
} else {
  console.log('[oura] OURA_TOKEN not set — Oura sync disabled');
}

const shutdown = () => {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
