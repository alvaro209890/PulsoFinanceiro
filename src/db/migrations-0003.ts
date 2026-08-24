/**
 * Migração 0003 — F2: núcleo financeiro determinístico.
 *
 * Fontes: docs/05-modelo-de-dados.md §4 (balance_snapshots, faturas,
 * pagamentos e matches), docs/06 §279 (snapshot copia `open_bill_*` e não
 * é reescrito por job posterior) e docs/09 §4.1 (patrimônio observável).
 *
 * Tudo monetário nas tabelas novas é INTEGER em unidade mínima (centavos):
 * métricas somam inteiros, nunca ponto flutuante (docs/05 §8).
 */

export const MIGRATION_0003 = {
  id: 3,
  name: 'f2-nucleo-financeiro',
  sql: `
-- Série histórica do patrimônio observável. A obrigação aberta do cartão é
-- COPIADA para dentro do snapshot no instante da fotografia; job posterior
-- nunca reescreve dia anterior (docs/06 §279, docs/09 §4.1).
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id                       TEXT PRIMARY KEY,
  account_public_id        TEXT NOT NULL REFERENCES accounts(public_id) ON DELETE CASCADE,
  sync_run_id              TEXT,
  snapshot_date            TEXT NOT NULL,
  captured_at              TEXT NOT NULL,
  balance_minor            INTEGER,
  closing_balance_minor    INTEGER,
  open_bill_amount_minor   INTEGER,
  open_bill_due_date       TEXT,
  open_bill_currency_code  TEXT,
  open_bill_source         TEXT NOT NULL
    CHECK (open_bill_source IN ('BILLS','TRANSACTIONS_FALLBACK','UNAVAILABLE')),
  open_bill_quality        TEXT NOT NULL
    CHECK (open_bill_quality IN ('COMPLETE','PARTIAL','UNAVAILABLE')),
  currency_code            TEXT NOT NULL,
  UNIQUE (account_public_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account_date
  ON balance_snapshots(account_public_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS credit_card_bills (
  public_id                    TEXT PRIMARY KEY,
  external_id                  TEXT UNIQUE NOT NULL,
  account_public_id            TEXT NOT NULL REFERENCES accounts(public_id) ON DELETE CASCADE,
  due_date                     TEXT NOT NULL,
  bill_closing_date            TEXT,
  total_amount_minor           INTEGER NOT NULL,
  currency_code                TEXT NOT NULL,
  minimum_payment_amount_minor INTEGER,
  updated_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bills_account_due
  ON credit_card_bills(account_public_id, due_date DESC);

CREATE TABLE IF NOT EXISTS bill_payments (
  public_id        TEXT PRIMARY KEY,
  external_id      TEXT UNIQUE NOT NULL,
  bill_public_id   TEXT NOT NULL REFERENCES credit_card_bills(public_id) ON DELETE CASCADE,
  payment_date     TEXT,
  amount_minor     INTEGER NOT NULL,
  currency_code    TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Vínculo auditável dos DOIS lados do pagamento de fatura. Sem linha aqui,
-- nenhuma métrica pode chamar uma transação de "pagamento de fatura"
-- (docs/07 §convenções, docs/09 §2.2).
CREATE TABLE IF NOT EXISTS transaction_bill_payment_matches (
  id                      TEXT PRIMARY KEY,
  bill_payment_public_id  TEXT NOT NULL REFERENCES bill_payments(public_id) ON DELETE CASCADE,
  transaction_public_id   TEXT NOT NULL REFERENCES transactions(public_id) ON DELETE CASCADE,
  role                    TEXT NOT NULL CHECK (role IN ('BANK_DEBIT','CARD_CREDIT')),
  confidence              TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM')),
  evidence_json           TEXT NOT NULL CHECK (json_valid(evidence_json)),
  algorithm_version       TEXT NOT NULL,
  matched_at              TEXT NOT NULL,
  UNIQUE (bill_payment_public_id, role),
  UNIQUE (transaction_public_id, role)
);
CREATE INDEX IF NOT EXISTS idx_bill_matches_tx
  ON transaction_bill_payment_matches(transaction_public_id);

-- Raiz de dois dígitos usada no rollup e na regra de transferência interna
-- (docs/04 §categorias: prefixo 04 = mesma titularidade).
ALTER TABLE categories ADD COLUMN level1_prefix TEXT;
UPDATE categories SET level1_prefix = substr(id, 1, 2) WHERE level1_prefix IS NULL;

-- Campos de crédito da conta, necessários ao snapshot e ao card de limite.
ALTER TABLE accounts ADD COLUMN credit_limit REAL;
ALTER TABLE accounts ADD COLUMN available_credit_limit REAL;
ALTER TABLE accounts ADD COLUMN closing_balance REAL;

-- Revisão de dados: incrementa uma vez por commit que altera dado capaz de
-- afetar métrica; é a base do ETag dos agregados (docs/07 §cache e ETag).
CREATE TABLE IF NOT EXISTS system_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO system_state (key, value) VALUES ('data_revision', '1');
`,
};
