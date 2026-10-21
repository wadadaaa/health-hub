-- Two kinds of thing the model cannot hold on its own.
--
-- `facts` is what stays true between conversations: allergies, the places she
-- eats, a standing constraint, a goal. Small, hand-sized, and read into every
-- turn, so it is kept to one line per fact on purpose.
--
-- `meal_corrections` is the record of being wrong. Every edit to a meal writes
-- the before and the after here, which over months is the only honest way to
-- find out which kinds of food the estimate systematically under-reads.

CREATE TABLE IF NOT EXISTS facts (
  key        TEXT PRIMARY KEY,
  value      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meal_corrections (
  id          BIGSERIAL PRIMARY KEY,
  meal_id     BIGINT,
  day         DATE        NOT NULL,
  category    TEXT        NOT NULL,
  description TEXT        NOT NULL,
  before_kcal INTEGER     NOT NULL,
  after_kcal  INTEGER     NOT NULL,
  before_protein_g NUMERIC,
  after_protein_g  NUMERIC,
  before_fat_g     NUMERIC,
  after_fat_g      NUMERIC,
  before_carbs_g   NUMERIC,
  after_carbs_g    NUMERIC,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meal_corrections_category_idx ON meal_corrections (category, id);
