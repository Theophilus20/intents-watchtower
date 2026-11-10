-- Intents Watchtower schema (Postgres 14+ / Supabase / PGlite).
-- Amounts are NUMERIC(78,0) in smallest units; money thresholds are BIGINT USD cents.

CREATE TABLE IF NOT EXISTS credits (
  id              TEXT PRIMARY KEY,
  asset           TEXT NOT NULL,
  amount          NUMERIC(78,0) NOT NULL,
  account         TEXT NOT NULL,
  near_tx         TEXT NOT NULL,
  source_tx_ref   TEXT,
  at_ms           BIGINT NOT NULL,
  matched_deposit_id TEXT
);
CREATE INDEX IF NOT EXISTS credits_asset_time ON credits (asset, at_ms);
CREATE INDEX IF NOT EXISTS credits_unmatched ON credits (asset) WHERE matched_deposit_id IS NULL;

CREATE TABLE IF NOT EXISTS deposits (
  id          TEXT PRIMARY KEY,
  asset       TEXT NOT NULL,
  amount      NUMERIC(78,0) NOT NULL,
  account     TEXT,
  source_tx   TEXT NOT NULL,
  at_ms       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS deposits_asset_time ON deposits (asset, at_ms);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          TEXT PRIMARY KEY,
  asset       TEXT NOT NULL,
  amount      NUMERIC(78,0) NOT NULL,
  account     TEXT NOT NULL,
  near_tx     TEXT NOT NULL,
  dest_chain  TEXT NOT NULL,
  dest_tx     TEXT,
  at_ms       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS withdrawals_asset_time ON withdrawals (asset, at_ms);
CREATE INDEX IF NOT EXISTS withdrawals_account ON withdrawals (account, at_ms);

CREATE TABLE IF NOT EXISTS custody_snapshots (
  asset       TEXT NOT NULL,
  balance     NUMERIC(78,0) NOT NULL,
  at_ms       BIGINT NOT NULL,
  PRIMARY KEY (asset, at_ms)
);

CREATE TABLE IF NOT EXISTS supply_snapshots (
  asset               TEXT NOT NULL,
  credited            NUMERIC(78,0) NOT NULL,
  pending_withdrawals NUMERIC(78,0) NOT NULL DEFAULT 0,
  at_ms               BIGINT NOT NULL,
  PRIMARY KEY (asset, at_ms)
);

CREATE TABLE IF NOT EXISTS solver_fills (
  id          TEXT PRIMARY KEY,
  route       TEXT NOT NULL,
  solver      TEXT NOT NULL,
  usd_cents   BIGINT NOT NULL,
  at_ms       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS fills_route_time ON solver_fills (route, at_ms);

CREATE TABLE IF NOT EXISTS chain_status (
  chain               TEXT NOT NULL,
  head_height         BIGINT NOT NULL,
  head_time_ms        BIGINT NOT NULL,
  finality_lag_blocks INTEGER,
  reorg_depth         INTEGER,
  at_ms               BIGINT NOT NULL,
  PRIMARY KEY (chain, at_ms)
);

-- One row per route per epoch: the full verdict, verifiable against report_hash.
CREATE TABLE IF NOT EXISTS route_health (
  route         TEXT NOT NULL,
  epoch         BIGINT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('green','amber','unknown','red')),
  raw_status    TEXT NOT NULL,
  score         SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons       TEXT[] NOT NULL DEFAULT '{}',
  report_hash   CHAR(64) NOT NULL,
  report        JSONB NOT NULL,
  computed_at_ms BIGINT NOT NULL,
  PRIMARY KEY (route, epoch)
);
CREATE INDEX IF NOT EXISTS route_health_status ON route_health (status, epoch DESC);

CREATE TABLE IF NOT EXISTS attestations (
  route        TEXT NOT NULL,
  epoch        BIGINT NOT NULL,
  report_hash  CHAR(64) NOT NULL,
  watcher_id   TEXT NOT NULL,
  signature    TEXT NOT NULL,
  submitted_tx TEXT,
  at_ms        BIGINT NOT NULL,
  PRIMARY KEY (route, epoch, watcher_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id             BIGSERIAL PRIMARY KEY,
  route          TEXT NOT NULL,
  severity       TEXT NOT NULL,
  from_status    TEXT,
  reasons        TEXT[] NOT NULL DEFAULT '{}',
  explanation    TEXT NOT NULL,
  lang           TEXT NOT NULL DEFAULT 'en',
  evidence_links TEXT[] NOT NULL DEFAULT '{}',
  report_hash    CHAR(64),
  sent_at_ms     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_time ON alerts (sent_at_ms DESC);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id          BIGINT PRIMARY KEY,
  intent_hash         TEXT NOT NULL,
  route               TEXT NOT NULL,
  status_at_execution TEXT,
  safe                BOOLEAN NOT NULL,
  report_hash         CHAR(64),
  at_ms               BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS engine_state (
  watcher_id  TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  as_of_ms    BIGINT NOT NULL,
  inputs_digest CHAR(64) NOT NULL
);
