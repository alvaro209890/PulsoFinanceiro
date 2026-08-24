/**
 * Schema do banco — fonte: docs/05-modelo-de-dados.md.
 *
 * Base mínima da F0/F1 (migração 0001): categorias, contas, transações,
 * itens, outbox de eventos e milestones. A 0003 acrescenta o núcleo
 * financeiro da F2 (snapshots, faturas, matches de pagamento). Upsert por ID externo preserva
 * o public_id local ULID (docs/04 §6).
 */
import type Database from 'better-sqlite3';
import { MIGRATION_0002 } from './migrations-0002.js';
import { MIGRATION_0003 } from './migrations-0003.js';

export const MIGRATIONS: readonly { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'base-f0',
    sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS items (
  public_id        TEXT PRIMARY KEY,
  external_id      TEXT UNIQUE NOT NULL,
  status           TEXT NOT NULL,
  execution_status TEXT,
  last_updated_at  TEXT,
  next_auto_sync_at TEXT,
  consent_expires_at TEXT,
  last_error_code  TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id                     TEXT PRIMARY KEY,
  description            TEXT NOT NULL,
  description_translated TEXT NOT NULL,
  parent_id              TEXT REFERENCES categories(id),
  synced_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS accounts (
  public_id   TEXT PRIMARY KEY,
  external_id TEXT UNIQUE NOT NULL,
  item_public_id TEXT NOT NULL REFERENCES items(public_id),
  type        TEXT NOT NULL,
  subtype     TEXT,
  label       TEXT NOT NULL,
  balance     REAL,
  currency    TEXT NOT NULL DEFAULT 'BRL',
  synced_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_item ON accounts(item_public_id);

CREATE TABLE IF NOT EXISTS transactions (
  public_id     TEXT PRIMARY KEY,
  external_id   TEXT UNIQUE NOT NULL,
  account_public_id TEXT NOT NULL REFERENCES accounts(public_id),
  amount        REAL NOT NULL,
  currency      TEXT NOT NULL,
  date          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('POSTED','PENDING')),
  type          TEXT CHECK (type IN ('DEBIT','CREDIT')),
  operation_type TEXT,
  description   TEXT,
  category_id   TEXT REFERENCES categories(id),
  balance_after REAL,
  order_tiebreak INTEGER,
  is_internal_transfer INTEGER NOT NULL DEFAULT 0,
  category_override INTEGER NOT NULL DEFAULT 0,
  raw_json_sanitized TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_public_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS sync_runs (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('daily','full','webhook-triggered')),
  ok          INTEGER,
  pages_fetched INTEGER,
  txs_upserted  INTEGER,
  error_code  TEXT
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id             TEXT PRIMARY KEY,
  event_type     TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','HIGH','CRITICAL')),
  payload_json   TEXT NOT NULL,
  dedup_key      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','LEASED','DELIVERED','DISMISSED','DEAD_LETTER')),
  occurred_at    TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  condition_closed_at TEXT,
  available_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  lease_owner    TEXT,
  lease_until    TEXT,
  lease_token_hash TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  delivery_id    TEXT,
  delivered_at   TEXT,
  dismissed_reason_code TEXT,
  dismissed_at   TEXT,
  last_error_code TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_active_dedup
  ON outbox_events(dedup_key) WHERE condition_closed_at IS NULL;

CREATE TABLE IF NOT EXISTS milestone_events (
  id            TEXT PRIMARY KEY,
  milestone_key TEXT NOT NULL,
  period        TEXT NOT NULL,
  computed_at   TEXT NOT NULL,
  celebrated_at TEXT,
  UNIQUE(milestone_key, period)
);

CREATE TABLE IF NOT EXISTS service_principals (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  current_token_hash TEXT NOT NULL,
  next_token_hash   TEXT,
  scopes_json       TEXT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at        TEXT
);
`,
  },
  MIGRATION_0002,
  MIGRATION_0003,
];

/** Aplica migrações pendentes. Idempotente e transacional por migração. */
export function migrate(db: Database.Database): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    const done = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(m.id);
    if (done) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
    });
    run();
    applied.push(m.id);
  }
  return { applied };
}
