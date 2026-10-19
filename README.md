# health-hub

A personal backend for meals and wearable data: Postgres for storage, an MCP server
for Claude, and a small REST API for your own clients (a Telegram bot, a dashboard).

```
                    ┌─────────────────────────┐
  claude.ai ──MCP──▶│                         │◀── Health Auto Export (iOS)  POST /webhook/health-auto-export
  Claude Code ─MCP─▶│  health-hub (Node/TS)   │◀── iOS Shortcut              POST /webhook/shortcut
  your bot ──REST──▶│  + Postgres             │──▶ Oura API v2 (hourly cron)
                    └─────────────────────────┘
```

Photos of meals stay in the chat; what lands in the database is the estimate
(calories, macros) and a short description.

## Stack

Node 22, TypeScript, Express 5, `@modelcontextprotocol/sdk` (stateless Streamable
HTTP), `pg`, `node-cron`. Deployment: docker compose — app + Postgres 16, with
either Caddy (standalone) or an existing Traefik (Hostinger template).

## Data model

| Table | What it holds |
|---|---|
| `meals` | one row per meal: local calendar `day`, kcal, protein/fat/carbs, confidence, source |
| `daily_metrics` | one row per `(day, source)`: active_kcal, steps, resting_hr, hrv, sleep_min, readiness, workout_min, raw payload |
| `weights` | weigh-ins |
| `targets` | versioned targets; the latest row with `valid_from <= day` applies |

**Daily budget** = `kcal + active_factor × max(0, active_kcal − active_baseline)`,
never below `min_kcal`. Defaults: `1500 + 0.6 × max(0, active − 300)`, floor 1400.
The extra from activity is added to carbs; protein and fat targets stay fixed.
A day counts as `training` when a workout ran for 20+ minutes or active energy
exceeded `baseline + 250`.

When several sources report the same day, fields are merged by precedence:
active energy, steps and workout minutes prefer Apple over Oura; sleep, HRV,
resting heart rate and readiness prefer Oura over Apple; `manual` always wins.

Days are computed in the app against `TZ_LOCAL`, not in SQL, so a midnight snack
lands on the day you'd expect.

## MCP tools

`log_meal`, `update_meal`, `delete_meal`, `get_day`, `get_week`, `log_weight`,
`weight_trend`, `get_targets`, `set_targets`, `sync_oura`.

Two endpoints serve them:

- `POST https://$DOMAIN/mcp/$MCP_PATH_SECRET` — no headers, for **claude.ai →
  Add custom connector**, which cannot send custom headers; the secret therefore
  lives in the path.
- `POST https://$DOMAIN/mcp` with `Authorization: Bearer $API_TOKEN` — for Claude
  Code and bots.

A wrong secret returns 404 rather than 401, so the endpoint does not advertise itself.

## Deploying

### Hostinger VPS (Docker + Traefik template)

Traefik already holds 80/443, so the app attaches to it with labels instead of
running its own reverse proxy.

1. hPanel → VPS → Docker Manager → **Compose** → **Compose from URL**:
   `https://raw.githubusercontent.com/wadadaaa/health-hub/main/docker-compose.hostinger.yml`
2. Fill the **Environment** field:
   ```
   APP_HOST=health.srv1728444.hstgr.cloud
   POSTGRES_PASSWORD=<openssl rand -hex 24>
   MCP_PATH_SECRET=<openssl rand -hex 24>
   API_TOKEN=<openssl rand -hex 24>
   ```
3. Deploy. Traefik requests the certificate on first request.

### Any other VPS

```bash
git clone https://github.com/wadadaaa/health-hub && cd health-hub
cp .env.example .env
openssl rand -hex 24   # ×3: POSTGRES_PASSWORD, MCP_PATH_SECRET, API_TOKEN
# set DOMAIN (an A record pointing at the box) and the secrets
docker compose up -d --build
curl https://$DOMAIN/healthz
```

Migrations in `sql/*.sql` run at startup. Ports 80 and 443 must be open.

### Connecting Claude

claude.ai → Settings → Connectors → Add custom connector →
`https://$DOMAIN/mcp/$MCP_PATH_SECRET`, no OAuth.

```bash
claude mcp add --transport http health-hub https://$DOMAIN/mcp \
  --header "Authorization: Bearer $API_TOKEN"
```

## Feeding it data

### Oura

Oura stopped issuing personal access tokens, so this uses OAuth2 (authorization
code with PKCE).

1. Register an application at https://cloud.ouraring.com/oauth/applications with
   redirect URI `https://$DOMAIN/oura/callback`.
2. Set `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` and `PUBLIC_URL`, then redeploy.
3. Open `https://$DOMAIN/oura/connect/$MCP_PATH_SECRET` once and approve. The
   callback stores the tokens and immediately backfills the last 14 days.

The connect route sits behind the same secret as the MCP endpoint, so a stranger
cannot bind their own Oura account to the server; the callback is a fixed URI
(Oura matches it exactly) and is guarded by the `state` it issued.

Refresh tokens are single-use: every refresh returns a new one, and the server
replaces the stored row in the same statement. `GET /api/oura/status` reports
whether it is connected and when the current access token expires.

After that the server syncs hourly (`OURA_CRON`) over the last
`OURA_BACKFILL_DAYS` days, and once at startup. A longer backfill:

```bash
docker compose exec app node dist/ingest/oura-cli.js 60
```

### Apple Health / Apple Watch

Apple offers no cloud API, so the phone pushes. Two ways:

**Health Auto Export** (App Store, paid) — Automations → new → REST API:

- URL `https://$DOMAIN/webhook/health-auto-export`, header `Authorization: Bearer $API_TOKEN`
- Format JSON, aggregate by day or hour, period today or previous days
- Metrics: Active Energy, Step Count, Resting Heart Rate, Heart Rate Variability,
  Sleep Analysis, Weight/Body Mass, Apple Exercise Time; enable Workouts
- Interval: every 1–2 hours

Units are converted automatically (kJ → kcal, lb → kg, sleep hours → minutes).
Metrics the parser doesn't recognise come back in the response under `unknown`
and are kept in `payload`.

**A Shortcut** (free, coarser) — "Find Health Samples" for the types you want,
assemble a dictionary, then "Get Contents of URL":

```json
{ "date": "2026-10-19", "active_kcal": 412, "steps": 7800, "resting_hr": 55,
  "hrv": 38, "sleep_min": 405, "workout_min": 35, "weight_kg": 82.0 }
```

to `POST https://$DOMAIN/webhook/shortcut` with the same bearer header. Every
field is optional; `"source": "manual"` overrides whatever the devices reported.
Run it from an Automation on a schedule.

Oura also writes into Apple Health, so Health Auto Export alone can cover both —
but readiness scores only arrive through the Oura API.

## REST API (bearer `API_TOKEN`)

```
GET  /api/day?date=YYYY-MM-DD
GET  /api/week?end=YYYY-MM-DD
GET  /api/weight?days=28
POST /api/meals        { description, kcal, protein_g?, fat_g?, carbs_g?, confidence?, eaten_at?, source? }
POST /api/ingest/oura?days=3
```

A Telegram bot: photo → Claude API (vision) → estimate → `POST /api/meals` →
reply with `remaining` from `GET /api/day`.

## Instructions for Claude

Worth pasting into project instructions or memory:

> On a food photo: call `get_day` first, estimate calories and macros at the
> upper-middle of the plausible range, then `log_meal` with a confidence. Reply
> with what's on the plate, the estimate, and what's left for the day. If the
> user corrects an ingredient, `update_meal` by id. A weight mentioned in chat
> goes to `log_weight`. Judge progress by `weight_trend.avg7` and `delta_week`,
> never by a single weigh-in. The budget comes from `get_day.budget` — don't
> recompute it by hand.

## Development

```bash
npm install
npm test               # both suites below
npm run test:smoke     # in-memory Postgres (pg-mem): MCP handshake, tools, webhooks, REST
npm run test:oura      # Oura OAuth2: PKCE, single-use state, refresh rotation
npm run dev            # needs DATABASE_URL and the secrets in the environment
npm run build
```

## Next

- OAuth 2.1 in front of `/mcp` (the SDK ships `mcpAuthRouter`), to drop the
  secret from the path.
- A Telegram bot on top of `/api/*`.
- A weekly dashboard over `/api/week`.
- A nightly job that posts the day's summary.
