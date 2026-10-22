-- Menstrual cycle, logged by hand.
--
-- Oura's API exposes no cycle endpoint, so the start of a period is something
-- she tells the bot. Everything else — cycle day, phase, the expected next
-- start — is derived from her own history rather than from a textbook 28 days.
--
-- This earns its place in a weight-loss tool for one unglamorous reason: fluid
-- retention in the second half of the cycle routinely moves the scale by one
-- to two kilograms, which is larger than a fortnight of actual fat loss. A
-- trend read without it will show a plateau that is not there.

CREATE TABLE IF NOT EXISTS cycle_events (
  id         BIGSERIAL PRIMARY KEY,
  day        DATE        NOT NULL,
  kind       TEXT        NOT NULL CHECK (kind IN ('period_start', 'period_end')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (day, kind)
);

CREATE INDEX IF NOT EXISTS cycle_events_day_idx ON cycle_events (kind, day DESC);

-- Oura reports nightly skin temperature as a deviation from the wearer's own
-- baseline. It rises by roughly 0.3 °C after ovulation, which is the one
-- signal in the existing data that corroborates a phase she has not logged.
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS temp_deviation NUMERIC;
