import { loadConfig } from './config.js';
import { startBriefingCron, startOuraCron } from './cron.js';
import { createPool, migrate } from './db.js';
import { setTimezone } from './dates.js';
import { createApp } from './http.js';
import type { TokenSource } from './ingest/oura.js';
import { getAccessToken, type OuraOAuthConfig } from './oura-auth.js';
import { createReadiness, keepTrying } from './readiness.js';
import { getSetting } from './settings.js';
import { setWebhook } from './telegram.js';

const config = loadConfig();
setTimezone(config.TZ_LOCAL);

const pool = createPool(config.DATABASE_URL);

// Oura: OAuth2 when an app is registered, otherwise a legacy personal token.
const ouraOAuth: OuraOAuthConfig | null =
  config.OURA_CLIENT_ID && config.OURA_CLIENT_SECRET && config.PUBLIC_URL
    ? {
        clientId: config.OURA_CLIENT_ID,
        clientSecret: config.OURA_CLIENT_SECRET,
        redirectUri: `${config.PUBLIC_URL.replace(/\/+$/, '')}/oura/callback`,
      }
    : null;

const ouraTokenSource: TokenSource | null = ouraOAuth
  ? () => getAccessToken(pool, ouraOAuth)
  : (config.OURA_TOKEN ?? null);

// Listen first. The database may still be starting, and a process that exits
// here would restart-loop behind the proxy with nothing to read.
const readiness = createReadiness();
const app = createApp({
  db: pool,
  config,
  oura: { oauth: ouraOAuth, tokenSource: ouraTokenSource },
  readiness,
  publicUrl: config.PUBLIC_URL,
});
const server = app.listen(config.PORT, () => {
  console.log(`[http] listening on :${config.PORT}`);
  console.log(`[mcp] POST /mcp/<MCP_PATH_SECRET>  (claude.ai custom connector)`);
  console.log(`[mcp] POST /mcp  with Bearer API_TOKEN  (Claude Code, bots)`);
});

// Nothing below should be able to kill the process.
process.on('unhandledRejection', e => console.error('[unhandled]', e));
process.on('uncaughtException', e => console.error('[uncaught]', e));

void keepTrying(readiness, async () => {
  const ran = await migrate(pool);
  if (ran.length) console.log(`[db] applied migrations: ${ran.join(', ')}`);
  return ran;
}).then(() => {
  console.log('[db] ready');

  if (ouraOAuth) {
    console.log('[oura] OAuth2 ready; connect once at /oura/connect/<MCP_PATH_SECRET>');
  } else if (config.OURA_TOKEN) {
    console.log('[oura] using a legacy personal access token');
  } else {
    console.log('[oura] not configured — set OURA_CLIENT_ID, OURA_CLIENT_SECRET and PUBLIC_URL');
  }

  if (ouraTokenSource) {
    startOuraCron(pool, ouraTokenSource, config.OURA_CRON, config.OURA_BACKFILL_DAYS, config.TZ_LOCAL);
    console.log(`[oura] cron "${config.OURA_CRON}" (${config.TZ_LOCAL})`);
  }

  startBriefingCron(pool, config.BRIEFING_CRON, config.TZ_LOCAL);
  console.log(`[briefing] cron "${config.BRIEFING_CRON}" (${config.TZ_LOCAL})`);

  // Re-point Telegram at this deployment, in case the public URL changed.
  void (async () => {
    const [token, secret] = await Promise.all([
      getSetting(pool, 'telegram_bot_token'),
      getSetting(pool, 'telegram_webhook_secret'),
    ]);
    if (!token || !secret || !config.PUBLIC_URL) return;
    const url = `${config.PUBLIC_URL.replace(/\/+$/, '')}/telegram/${secret}`;
    try {
      await setWebhook(token, url, secret);
      console.log('[telegram] webhook registered');
    } catch (e) {
      console.error('[telegram] webhook registration failed:', e instanceof Error ? e.message : e);
    }
  })();
});

const shutdown = () => {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
