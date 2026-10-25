-- Individual training sessions.
--
-- daily_metrics already carries workout minutes per day, which answers "did
-- she train" but not "what was it and how hard". A plan has to be judged
-- against sessions, so sessions get their own table.
--
-- Three things can write here: Oura's workout collection (automatic, coarse),
-- Health Auto Export or a Shortcut from the phone (automatic, detailed), and
-- the chat (manual, and the only source of how it actually felt).
--
-- external_id makes a re-sync idempotent: Oura and Apple both hand out stable
-- ids, and a manual entry simply has none.

CREATE TABLE IF NOT EXISTS workouts (
  id           BIGSERIAL PRIMARY KEY,
  day          DATE        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  sport        TEXT        NOT NULL,
  minutes      NUMERIC     NOT NULL,
  distance_km  NUMERIC,
  avg_hr       INTEGER,
  max_hr       INTEGER,
  kcal         INTEGER,
  -- Borg CR10: 1 is a stroll, 10 is everything she had. The one number no
  -- device can measure and the one a coach asks for first.
  rpe          INTEGER CHECK (rpe BETWEEN 1 AND 10),
  note         TEXT,
  source       TEXT        NOT NULL DEFAULT 'manual',
  external_id  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plain rather than partial: in Postgres two NULLs never collide, so manual
-- rows with no external id coexist happily under the same constraint.
CREATE UNIQUE INDEX IF NOT EXISTS workouts_external_idx ON workouts (source, external_id);
CREATE INDEX IF NOT EXISTS workouts_day_idx ON workouts (day DESC, started_at DESC);
