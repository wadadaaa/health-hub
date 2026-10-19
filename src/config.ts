import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),

  // MCP endpoint is reachable at /mcp/<MCP_PATH_SECRET> without any other auth,
  // which is what claude.ai "Add custom connector" needs (no custom headers there).
  // Other clients (Claude Code, Telegram bot) can instead call /mcp with a Bearer API_TOKEN.
  MCP_PATH_SECRET: z.string().min(24),
  API_TOKEN: z.string().min(24),

  // Public origin, used to build the Oura redirect URI.
  PUBLIC_URL: z.string().url().optional(),

  // Legacy Oura personal access token. Oura deprecated these; OAuth2 below
  // takes precedence when both are configured.
  OURA_TOKEN: z.string().optional(),
  OURA_CLIENT_ID: z.string().optional(),
  OURA_CLIENT_SECRET: z.string().optional(),
  OURA_CRON: z.string().default('17 * * * *'),
  OURA_BACKFILL_DAYS: z.coerce.number().int().positive().default(3),

  TZ_LOCAL: z.string().default('Asia/Jerusalem'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment:\n  ${issues}`);
  }
  return parsed.data;
}
