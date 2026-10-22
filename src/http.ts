import { composeBriefing } from './briefing.js';
import { energyBalance } from './energy.js';
import { insights } from './insights.js';
import { cycleStatus, logPeriodStart } from './cycle.js';
import { calibration, listFacts } from './memory.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { Queryable } from './db.js';
import { isDay, today } from './dates.js';
import { ingestHealthAutoExport, ingestShortcut } from './ingest/apple.js';
import { ingestOura, type TokenSource } from './ingest/oura.js';
import { completeFlow, startFlow, status as ouraStatus, type OuraOAuthConfig } from './oura-auth.js';
import type { Readiness } from './readiness.js';
import { describeSettings, getSetting, setSetting, type SettingKey } from './settings.js';
import { handleUpdate, setWebhook } from './telegram.js';
import { createMcpServer } from './mcp.js';
import { getDay, getWeek, logMeal, weightTrend } from './service.js';

export interface AppDeps {
  db: Queryable;
  config: Pick<Config, 'MCP_PATH_SECRET' | 'API_TOKEN'>;
  /** Startup state; the server listens before the database is reachable. */
  readiness?: Readiness;
  /** Public origin, used to build the Telegram webhook URL. */
  publicUrl?: string;
  /** Null when Oura has not been configured at all. */
  oura: {
    /** OAuth2 app credentials; null when only a legacy personal token is set. */
    oauth: OuraOAuthConfig | null;
    /** A static token or a refreshing provider; null when Oura is unconfigured. */
    tokenSource: TokenSource | null;
  };
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: Request): string | undefined {
  const h = req.header('authorization') ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}

export function createApp({ db, config, oura, readiness, publicUrl }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Health Auto Export can send multi-megabyte payloads on a first sync.
  app.use(express.json({ limit: '25mb' }));

  const requireApiToken = (req: Request, res: Response, next: NextFunction) => {
    if (safeEqual(bearer(req), config.API_TOKEN)) return next();
    res.status(401).json({ error: 'unauthorized' });
  };

  // Reports the startup state rather than just liveness: with no shell on the
  // box this is the only way to see why the app is not serving.
  app.get('/healthz', (_req, res) => {
    const r = readiness;
    if (!r || r.phase === 'ready') {
      res.json({ ok: true, day: today(), migrations: r?.migrations ?? [] });
      return;
    }
    res.status(503).json({
      ok: false,
      day: today(),
      phase: r.phase,
      attempts: r.attempts,
      waiting_for_ms: Date.now() - r.since,
      error: r.lastError,
    });
  });

  // Everything below needs the database; answer honestly while it is coming up.
  const requireReady = (_req: Request, res: Response, next: NextFunction) => {
    if (!readiness || readiness.phase === 'ready') return next();
    res.status(503).json({ error: 'starting up', phase: readiness.phase, detail: readiness.lastError });
  };

  // ---------- MCP (stateless Streamable HTTP) ----------
  // Authorized either by the secret path (claude.ai custom connector, no headers possible)
  // or by Bearer API_TOKEN on /mcp (Claude Code, bots).
  const mcpAuthorized = (req: Request) =>
    safeEqual(req.params.secret as string | undefined, config.MCP_PATH_SECRET) ||
    safeEqual(bearer(req), config.API_TOKEN);

  const handleMcp = async (req: Request, res: Response) => {
    if (!mcpAuthorized(req)) {
      res.status(404).json({ error: 'not found' }); // don't advertise the endpoint
      return;
    }
    const server = createMcpServer({ db, ouraTokenSource: oura.tokenSource });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: one server+transport per request
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  const mcpMethodNotAllowed = (req: Request, res: Response) => {
    if (!mcpAuthorized(req)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Stateless server: only POST is supported' },
      id: null,
    });
  };
  for (const path of ['/mcp', '/mcp/:secret']) {
    app.post(path, requireReady, handleMcp);
    app.get(path, mcpMethodNotAllowed);
    app.delete(path, mcpMethodNotAllowed);
  }

  // ---------- Oura OAuth2 ----------
  // The start of the flow is behind the same secret as the MCP endpoint, so a
  // stranger cannot bind their own Oura account to this server. The callback is
  // a fixed URI (Oura requires an exact match) and is guarded by `state`.
  const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;` +
    `background:#0f1115;color:#e6e8ee}main{max-width:32rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}` +
    `p{margin:.25rem 0;color:#aab}</style><main>${body}</main>`;

  app.get('/oura/connect/:secret', async (req, res) => {
    if (!safeEqual(req.params.secret, config.MCP_PATH_SECRET)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!oura.oauth) {
      res.status(400).send(page('Oura', '<h1>Oura is not configured</h1><p>Set OURA_CLIENT_ID, OURA_CLIENT_SECRET and PUBLIC_URL, then redeploy.</p>'));
      return;
    }
    const { url } = await startFlow(db, oura.oauth);
    res.redirect(302, url);
  });

  app.get('/oura/callback', async (req, res) => {
    if (!oura.oauth) {
      res.status(400).send(page('Oura', '<h1>Oura is not configured</h1>'));
      return;
    }
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) {
      res.status(400).send(page('Oura', `<h1>Oura declined</h1><p>${String(error).slice(0, 120)}</p>`));
      return;
    }
    if (!code || !state) {
      res.status(400).send(page('Oura', '<h1>Missing code or state</h1><p>Start again from the connect link.</p>'));
      return;
    }
    try {
      const tokens = await completeFlow(db, oura.oauth, code, state);
      // Pull the recent past straight away so there is data to look at.
      let synced = 0;
      try {
        const r = await ingestOura(db, tokens.access_token, 14);
        synced = r.days.length;
      } catch {
        /* the cron will retry */
      }
      res.send(page('Oura connected', `<h1>Oura connected</h1><p>Synced ${synced} day(s). You can close this tab.</p>`));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(400).send(page('Oura', `<h1>Could not finish connecting</h1><p>${message.slice(0, 200)}</p>`));
    }
  });

  // ---------- Webhooks (Bearer API_TOKEN) ----------
  app.post('/webhook/health-auto-export', requireApiToken, requireReady, async (req, res) => {
    const result = await ingestHealthAutoExport(db, req.body ?? {});
    res.json({ ok: true, ...result });
  });

  app.post('/webhook/shortcut', requireApiToken, requireReady, async (req, res) => {
    const result = await ingestShortcut(db, req.body ?? {});
    res.json({ ok: true, ...result });
  });

  // ---------- Small REST API for other clients (Telegram bot, dashboards) ----------
  const api = express.Router();
  api.use(requireApiToken);
  api.use(requireReady);

  api.get('/day', async (req, res) => {
    const day = typeof req.query.date === 'string' && isDay(req.query.date) ? req.query.date : today();
    res.json(await getDay(db, day));
  });

  api.get('/week', async (req, res) => {
    const end = typeof req.query.end === 'string' && isDay(req.query.end) ? req.query.end : today();
    res.json(await getWeek(db, end));
  });

  api.get('/weight', async (req, res) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days ?? 28) || 28));
    res.json(await weightTrend(db, days));
  });

  api.get('/energy', async (req, res) => {
    const days = Math.min(120, Math.max(7, Number(req.query.days ?? 28) || 28));
    res.json(await energyBalance(db, days));
  });

  api.get('/insights', async (req, res) => {
    const days = Math.min(120, Math.max(7, Number(req.query.days ?? 28) || 28));
    res.json(await insights(db, days));
  });

  api.get('/cycle', async (req, res) => {
    const day = typeof req.query.date === 'string' && isDay(req.query.date) ? req.query.date : today();
    res.json(await cycleStatus(db, day));
  });

  api.post('/cycle/start', async (req, res) => {
    const b = req.body ?? {};
    const day = typeof b.day === 'string' && isDay(b.day) ? b.day : today();
    await logPeriodStart(db, day, typeof b.note === 'string' ? b.note : undefined);
    res.json(await cycleStatus(db, day));
  });

  api.get('/facts', async (_req, res) => {
    res.json({ facts: await listFacts(db) });
  });

  api.get('/calibration', async (_req, res) => {
    res.json(await calibration(db));
  });

  api.get('/briefing', async (_req, res) => {
    res.type('text/plain').send(await composeBriefing(db));
  });

  api.post('/meals', async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.description !== 'string' || typeof b.kcal !== 'number') {
      res.status(400).json({ error: 'description (string) and kcal (number) are required' });
      return;
    }
    const meal = await logMeal(db, {
      description: b.description,
      kcal: b.kcal,
      protein_g: b.protein_g,
      fat_g: b.fat_g,
      carbs_g: b.carbs_g,
      confidence: b.confidence,
      eaten_at: b.eaten_at ? new Date(b.eaten_at) : undefined,
      source: typeof b.source === 'string' ? b.source : 'api',
    });
    res.status(201).json(meal);
  });

  api.post('/ingest/oura', async (req, res) => {
    if (!oura.tokenSource) {
      res.status(400).json({ error: 'Oura is not configured' });
      return;
    }
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 3) || 3));
    res.json(await ingestOura(db, oura.tokenSource, days));
  });

  api.get('/oura/status', async (_req, res) => {
    res.json({ ...(await ouraStatus(db)), oauth_configured: oura.oauth !== null });
  });

  // ---------- Telegram ----------
  // Two gates: the secret in the path, and the token Telegram echoes in a
  // header. Both come from the same stored secret.
  app.post('/telegram/:secret', async (req, res) => {
    const expected = await getSetting(db, 'telegram_webhook_secret');
    const headerToken = req.header('x-telegram-bot-api-secret-token');
    if (!expected || !safeEqual(req.params.secret, expected) || !safeEqual(headerToken, expected)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // Answer immediately: Telegram retries anything slow, and the work can
    // take a few seconds against the vision model.
    res.json({ ok: true });

    const token = await getSetting(db, 'telegram_bot_token');
    if (!token) return;
    const anthropicKey = await getSetting(db, 'anthropic_api_key');
    void handleUpdate({ db, token, anthropicKey }, req.body ?? {});
  });

  api.get('/settings', async (_req, res) => {
    res.json(await describeSettings(db));
  });

  const SETTABLE: SettingKey[] = [
    'telegram_bot_token',
    'telegram_webhook_secret',
    'telegram_chat_id',
    'anthropic_api_key',
  ];

  api.put('/settings', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(body).filter(k => !SETTABLE.includes(k as SettingKey));
    if (unknown.length) {
      res.status(400).json({ error: `unknown settings: ${unknown.join(', ')}` });
      return;
    }
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== 'string' || !value) continue;
      await setSetting(db, key as SettingKey, value);
    }
    res.json(await describeSettings(db));
  });

  /** Points Telegram at this server, minting a webhook secret when there is none. */
  api.post('/telegram/register', async (_req, res) => {
    const token = await getSetting(db, 'telegram_bot_token');
    if (!token) {
      res.status(400).json({ error: 'telegram_bot_token is not set' });
      return;
    }
    const origin = publicUrl?.replace(/\/+$/, '');
    if (!origin) {
      res.status(400).json({ error: 'PUBLIC_URL is not configured' });
      return;
    }
    let secret = await getSetting(db, 'telegram_webhook_secret');
    if (!secret) {
      secret = randomBytes(24).toString('hex');
      await setSetting(db, 'telegram_webhook_secret', secret);
    }
    const url = `${origin}/telegram/${secret}`;
    await setWebhook(token, url, secret);
    res.json({ ok: true, url });
  });

  app.use('/api', api);

  // ---------- Errors ----------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[http]', message);
    if (!res.headersSent) res.status(500).json({ error: message });
  });

  return app;
}
