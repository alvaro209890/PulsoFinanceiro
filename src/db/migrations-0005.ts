/**
 * Migração 0005 — F8 Clarificação Privada e Regras de Contexto (docs/05 §modelo-de-dados e docs/07 §H5/F8).
 */

export const MIGRATION_0005 = {
  id: 5,
  name: 'f8-clarifications-and-rules',
  sql: `
CREATE TABLE IF NOT EXISTS transaction_clarifications (
  id                TEXT PRIMARY KEY,
  transaction_public_id TEXT NOT NULL REFERENCES transactions(public_id),
  version           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','EXPIRED','SUPERSEDED')),
  context_json      TEXT NOT NULL,
  suggestions_json  TEXT NOT NULL,
  matcher_kind      TEXT,
  matcher_confidence TEXT,
  resolved_category_id TEXT REFERENCES categories(id),
  normalized_alias  TEXT,
  resolution_type   TEXT CHECK (resolution_type IN ('ACCEPT_CATEGORY_SUGGESTION','SET_NORMALIZED_ALIAS')),
  idempotency_hash  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_clarifications_tx ON transaction_clarifications(transaction_public_id);
CREATE INDEX IF NOT EXISTS idx_clarifications_status ON transaction_clarifications(status);

CREATE TABLE IF NOT EXISTS transaction_context_rules (
  id                TEXT PRIMARY KEY,
  matcher_kind      TEXT NOT NULL,
  matcher_value     TEXT NOT NULL,
  category_id       TEXT REFERENCES categories(id),
  normalized_alias  TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  source_clarification_id TEXT REFERENCES transaction_clarifications(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_context_rules_match ON transaction_context_rules(matcher_kind, matcher_value);
`,
};
