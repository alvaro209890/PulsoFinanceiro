/**
 * Migração 0002 — F1: inbox de webhook e staleness (docs/05 §webhook_inbox,
 * docs/06 §7, docs/14 STALE_POLICY_V1).
 */
import type Database from 'better-sqlite3';

export const MIGRATION_0002 = {
  id: 2,
  name: 'f1-inbox-staleness',
  sql: `
CREATE TABLE IF NOT EXISTS webhook_inbox (
  event_id           TEXT PRIMARY KEY,
  event_type         TEXT NOT NULL CHECK (event_type IN ('item/updated','transactions/created','transactions/updated','transactions/deleted')),
  item_id            TEXT,
  account_id         TEXT,
  triggered_by       TEXT,
  payload_json       TEXT NOT NULL CHECK (json_valid(payload_json)),
  status             TEXT NOT NULL CHECK (status IN ('RECEIVED','PROCESSING','SUCCEEDED','FAILED','DEAD')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  received_at        TEXT NOT NULL,
  processing_started_at TEXT,
  processed_at       TEXT,
  next_attempt_at    TEXT,
  last_error_code    TEXT,
  last_error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON webhook_inbox(status, next_attempt_at);

-- Estado de staleness por item (fonte do SYNC_STALE e do widget de saúde)
ALTER TABLE items ADD COLUMN stale_bucket TEXT
  CHECK (stale_bucket IN ('OK','WARNING','HIGH','CRITICAL'));
ALTER TABLE items ADD COLUMN last_harvest_at TEXT;
`,
};
