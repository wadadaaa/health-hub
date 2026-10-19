# health-hub

Личный бэкенд: приёмы пищи + данные с носимых устройств (Apple Watch / Apple Health, Oura) в Postgres,
наружу — MCP-сервер для Claude (claude.ai, Claude Code) и небольшой REST API для своих клиентов (Telegram-бот и т.п.).

```
                    ┌─────────────────────────┐
  claude.ai ──MCP──▶│                         │◀── Health Auto Export (iOS)  POST /webhook/health-auto-export
  Claude Code ─MCP─▶│  health-hub (Node/TS)   │◀── iOS Shortcut              POST /webhook/shortcut
  Telegram-бот ─REST▶│  + Postgres             │──▶ Oura API v2 (cron)
                    └─────────────────────────┘
```

Всё состояние — в своей БД. Фото еды остаётся в чате; в базу уходят оценка (ккал/БЖУ) и описание.

## Стек

Node 22, TypeScript, Express 5, `@modelcontextprotocol/sdk` (Streamable HTTP, stateless), `pg`, `node-cron`.
Деплой: docker-compose (app + Postgres 16 + Caddy с автоматическим HTTPS).

## Данные

| Таблица | Что |
|---|---|
| `meals` | приёмы пищи: `day` (локальный календарный день, Asia/Jerusalem), ккал, Б/Ж/У, confidence, source |
| `daily_metrics` | по одной строке на `(day, source)`: active_kcal, steps, resting_hr, hrv, sleep_min, readiness, workout_min, raw payload |
| `weights` | взвешивания |
| `targets` | версии целей; действует последняя с `valid_from <= day` |

**Бюджет дня** = `kcal + active_factor × max(0, active_kcal − active_baseline)`, не ниже `min_kcal`.
По умолчанию: 1500 + 0.6 × max(0, active − 300), минимум 1400. Добавка идёт в углеводы, белок и жир фиксированы.
`day_type = training`, если тренировка ≥ 20 мин или active_kcal ≥ baseline + 250.

Когда один день есть в нескольких источниках: активные ккал/шаги/тренировка — Apple важнее Oura; сон/HRV/пульс покоя/readiness — Oura важнее Apple; `manual` перебивает всё.

## MCP-инструменты

`log_meal`, `update_meal`, `delete_meal`, `get_day`, `get_week`, `log_weight`, `weight_trend`, `get_targets`, `set_targets`, `sync_oura`.

Эндпоинты:
- `POST https://$DOMAIN/mcp/$MCP_PATH_SECRET` — без заголовков, для **claude.ai → Add custom connector** (там нельзя задать свои заголовки, поэтому секрет в пути).
- `POST https://$DOMAIN/mcp` с `Authorization: Bearer $API_TOKEN` — для Claude Code и ботов.

Неверный секрет → 404, чтобы эндпоинт не светился.

## Деплой на VPS

```bash
git clone <repo> && cd health-hub
cp .env.example .env
openssl rand -hex 24   # ×3: POSTGRES_PASSWORD, MCP_PATH_SECRET, API_TOKEN
# впиши DOMAIN (A-запись на VPS), секреты, OURA_TOKEN
docker compose up -d --build
docker compose logs -f app      # [db] applied migrations: 001_init.sql
curl https://$DOMAIN/healthz
```

Миграции (`sql/*.sql`) применяются при старте приложения. Порты 80/443 должны быть открыты в фаерволе.

### Подключить в claude.ai

Settings → Connectors → Add custom connector → URL `https://$DOMAIN/mcp/$MCP_PATH_SECRET`, без OAuth.
Проверить в новом чате: «что у меня по бюджету сегодня?» → Claude вызовет `get_day`.

### Подключить в Claude Code

```bash
claude mcp add --transport http health-hub https://$DOMAIN/mcp --header "Authorization: Bearer $API_TOKEN"
```

### Oura

Personal access token: https://cloud.ouraring.com/personal-access-tokens → `OURA_TOKEN` в `.env`.
Синк каждый час (`OURA_CRON`), последние `OURA_BACKFILL_DAYS` дней, плюс сразу при старте. Разовый бэкфилл:

```bash
docker compose exec app node dist/ingest/oura-cli.js 60   # последние 60 дней
```

### Apple Health / Apple Watch

Облачного API у Apple Health нет. Два пути:

**1. Health Auto Export** (App Store, платное) — Automations → новый → тип REST API:
- URL: `https://$DOMAIN/webhook/health-auto-export`
- Headers: `Authorization: Bearer $API_TOKEN`
- Format: JSON; Aggregate: Days (или Hours — парсер суммирует); Period: Today или Previous days
- Metrics: Active Energy, Step Count, Resting Heart Rate, Heart Rate Variability, Sleep Analysis, Weight/Body Mass, Apple Exercise Time; Workouts: включить
- Interval: каждые 1–2 часа

Единицы (kJ/kcal, lb/kg, часы сна) конвертируются автоматически. Незнакомые метрики попадают в ответ как `unknown` и в `payload`.

**2. Shortcut** (бесплатно, грубее) — «Find Health Samples» для нужных типов за сегодня → собрать словарь → «Get Contents of URL»:
- `POST https://$DOMAIN/webhook/shortcut`, header `Authorization: Bearer $API_TOKEN`, JSON:

```json
{ "date": "2026-10-19", "active_kcal": 412, "steps": 7800, "resting_hr": 55,
  "hrv": 38, "sleep_min": 405, "workout_min": 35, "weight_kg": 82.0 }
```

Все поля опциональны; `"source": "manual"` — чтобы перебить данные устройств. Запускать по расписанию через Automations (например, в 22:00).

Oura тоже пишет в Apple Health, так что через HAE можно обойтись без токена Oura — но readiness тогда не будет.

## REST для своих клиентов (Bearer `API_TOKEN`)

```
GET  /api/day?date=YYYY-MM-DD
GET  /api/week?end=YYYY-MM-DD
GET  /api/weight?days=28
POST /api/meals        { description, kcal, protein_g?, fat_g?, carbs_g?, confidence?, eaten_at?, source? }
POST /api/ingest/oura?days=3
```

Telegram-бот: фото → Claude API (vision) → оценка → `POST /api/meals` → ответ с `remaining` из `GET /api/day`.

## Инструкция для Claude (вставить в Project instructions или memory)

> При фото еды: сначала `get_day`, затем оценка ккал/БЖУ по верхне-средней границе, `log_meal` с confidence,
> в ответе — что в тарелке, оценка, остаток на день. Если пользователь уточняет состав — `update_meal` по id.
> Вес из чата — `log_weight`. Прогресс оценивать по `weight_trend.avg7` и `delta_week`, не по одному взвешиванию.
> Бюджет считает сервер (`get_day.budget`); не пересчитывать вручную.

## Разработка

```bash
npm install
npm run test:smoke     # in-memory Postgres (pg-mem): MCP handshake, инструменты, вебхуки, REST
npm run dev            # локально нужен DATABASE_URL и секреты в окружении
npm run build
```

## Что дальше

- OAuth 2.1 перед `/mcp` (SDK даёт `mcpAuthRouter`), чтобы убрать секрет из пути.
- Telegram-бот на Railway поверх `/api/*`.
- Дашборд недели (artifact или своя страница) по `/api/week`.
- Ночной отчёт: cron → итог дня → push.
