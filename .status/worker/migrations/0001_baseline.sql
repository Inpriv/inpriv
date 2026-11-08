-- Inpriv Status (D1 database "inpriv-status")
-- Health checks of the public Inpriv sites, every 5 minutes. Nothing here is
-- about people: only which site answered, how fast, and when.
--
-- Apply: npx wrangler d1 execute inpriv-status --remote --file schema.sql

-- One row per site per check. Kept 49 hours (the 24-hour view and the hero).
CREATE TABLE IF NOT EXISTS checks (
  service TEXT NOT NULL,          -- site | mail | temp | id
  at      INTEGER NOT NULL,       -- check time, ms, rounded to the 5-minute tick
  state   TEXT NOT NULL,          -- up | slow | down | maint
  ms      INTEGER,                -- response time; null when it didn't answer
  code    INTEGER,                -- HTTP status, 0 = no answer
  PRIMARY KEY (service, at)
) WITHOUT ROWID;

-- The same checks added up per hour. Kept 92 days (the 7, 30 and 90-day views).
CREATE TABLE IF NOT EXISTS hourly (
  service TEXT NOT NULL,
  hour    INTEGER NOT NULL,       -- floor(ms / 3 600 000)
  n       INTEGER NOT NULL DEFAULT 0,
  up      INTEGER NOT NULL DEFAULT 0,
  slow    INTEGER NOT NULL DEFAULT 0,
  down    INTEGER NOT NULL DEFAULT 0,
  maint   INTEGER NOT NULL DEFAULT 0,
  ms_sum  INTEGER NOT NULL DEFAULT 0,
  ms_n    INTEGER NOT NULL DEFAULT 0,
  ms_max  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service, hour)
) WITHOUT ROWID;

-- Outages and maintenance, opened and closed by the checks. Kept 92 days.
CREATE TABLE IF NOT EXISTS incidents (
  id      INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  kind    TEXT NOT NULL,          -- down | maint
  started INTEGER NOT NULL,       -- first failing check
  ended   INTEGER,                -- first good check after it; null while ongoing
  last    INTEGER NOT NULL,       -- latest failing check
  checks  INTEGER NOT NULL DEFAULT 1,
  note    TEXT                    -- the maintenance message shown on the site, if any
);
CREATE INDEX IF NOT EXISTS incidents_open ON incidents (service, ended);
CREATE INDEX IF NOT EXISTS incidents_started ON incidents (started);
