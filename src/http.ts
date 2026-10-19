import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { Queryable } from './db.js';
import { isDay, today } from './dates.js';
import { ingestHealthAutoExport, ingestShortcut } from './ingest/apple.js';
import { ingestOura } from './ingest/oura.js';
import { createMcpServer } from './mcp.js';
import { getDay, getWeek, logMeal, weightTrend } from './service.js';

export interface AppDeps {
  db: Queryable;
  config: Pick<Config, 'MCP_PATH_SECRET' | 'API_TOKEN' | 'OURA_TOKEN'>;
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

export function createApp({ db, config }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Health Auto Export can send multi-megabyte payloads on a first sync.
  app.use(express.json({ limit: '25mb' }));

  const requireApiToken = (req: Request, res: Response, next: NextFunction) => {
    if (safeEqual(bearer(req), config.API_TOKEN)) return next();
    res.status(401).json({ error: 'unauthorized' });
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, day: today() });
  });

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
    const server = createMcpServer({ db, ouraToken: config.OURA_TOKEN });
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
    app.post(path, handleMcp);
    app.get(path, mcpMethodNotAllowed);
    app.delete(path, mcpMethodNotAllowed);
  }

  // ---------- Webhooks (Bearer API_TOKEN) ----------
  app.post('/webhook/health-auto-export', requireApiToken, async (req, res) => {
    const result = await ingestHealthAutoExport(db, req.body ?? {});
    res.json({ ok: true, ...result });
  });

  app.post('/webhook/shortcut', requireApiToken, async (req, res) => {
    const result = await ingestShortcut(db, req.body ?? {});
    res.json({ ok: true, ...result });
  });

  // ---------- Small REST API for other clients (Telegram bot, dashboards) ----------
  const api = express.Router();
  api.use(requireApiToken);

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
    if (!config.OURA_TOKEN) {
      res.status(400).json({ error: 'OURA_TOKEN not configured' });
      return;
    }
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 3) || 3));
    res.json(await ingestOura(db, config.OURA_TOKEN, days));
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
