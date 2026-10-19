-- Meals logged from Claude (photo estimates), Telegram, or manually.
-- `day` is the local calendar day (Asia/Jerusalem by default), computed in the app
-- so that late-night snacks land on the right day without SQL timezone gymnastics.
CREATE TABLE IF NOT EXISTS meals (
  id          BIGSERIAL PRIMARY KEY,
  day         DATE NOT NULL,
  eaten_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT NOT NULL,
  kcal        INTEGER NOT NULL,
  protein_g   NUMERIC(6,1) NOT NULL DEFAULT 0,
  fat_g       NUMERIC(6,1) NOT NULL DEFAULT 0,
  carbs_g     NUMERIC(6,1) NOT NULL DEFAULT 0,
  confidence  TEXT,                      -- 'low' | 'medium' | 'high' (photo estimate quality)
  source      TEXT NOT NULL DEFAULT 'claude',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meals_day_idx ON meals (day);

-- One row per (day, source). Sources: 'apple' (Health Auto Export / Shortcut), 'oura', 'manual'.
-- Raw payload is kept so nothing is lost when the parser is too conservative.
CREATE TABLE IF NOT EXISTS daily_metrics (
  day          DATE NOT NULL,
  source       TEXT NOT NULL,
  active_kcal  INTEGER,
  steps        INTEGER,
  resting_hr   INTEGER,
  hrv          NUMERIC(6,1),
  sleep_min    INTEGER,
  readiness    INTEGER,
  workout_min  INTEGER,
  payload      JSONB,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, source)
);

CREATE TABLE IF NOT EXISTS weights (
  id          BIGSERIAL PRIMARY KEY,
  day         DATE NOT NULL,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kg          NUMERIC(5,2) NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS weights_day_idx ON weights (day);

-- Calorie/macro targets, versioned by valid_from. The latest row with valid_from <= day wins.
-- Daily budget = kcal + active_factor * max(0, active_kcal - active_baseline), never below min_kcal.
CREATE TABLE IF NOT EXISTS targets (
  id              BIGSERIAL PRIMARY KEY,
  valid_from      DATE NOT NULL,
  kcal            INTEGER NOT NULL,
  protein_g       INTEGER NOT NULL,
  fat_g           INTEGER NOT NULL,
  carbs_g         INTEGER NOT NULL,
  active_factor   NUMERIC(3,2) NOT NULL DEFAULT 0.60,
  active_baseline INTEGER NOT NULL DEFAULT 300,
  min_kcal        INTEGER NOT NULL DEFAULT 1400,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed initial targets once (edit later via the set_targets MCP tool).
INSERT INTO targets (valid_from, kcal, protein_g, fat_g, carbs_g, note)
SELECT '2026-10-19'::date, 1500, 120, 50, 140, 'initial: office day, 82 kg / 169 cm'
WHERE NOT EXISTS (SELECT 1 FROM targets);
