/**
 * Migração 0004 — F3: cartão e recorrências.
 *
 * Fontes: docs/05 §4 (`bill_finance_charges`, `account_credit_limits`,
 * `recurring_analysis`, `recurring_occurrences`), docs/09 §5–6 e o formato
 * real medido no tenant em 24/08/2026 (`/bills` devolve `financeCharges[]`
 * e `payments[]`; `creditCardMetadata.billForecastDate` vem como `YYYY-MM`).
 *
 * Escores ficam em basis points inteiros (0–10000); dinheiro em centavos.
 */

export const MIGRATION_0004 = {
  id: 4,
  name: 'f3-cartao-recorrencias',
  sql: `
-- Encargos da fatura (IOF, juros, multa…). Releitura completa da fatura
-- substitui os filhos dentro da transação do pai (docs/05 §faturas).
CREATE TABLE IF NOT EXISTS bill_finance_charges (
  id              TEXT PRIMARY KEY,
  bill_public_id  TEXT NOT NULL REFERENCES credit_card_bills(public_id) ON DELETE CASCADE,
  external_id     TEXT,
  type            TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL,
  currency_code   TEXT NOT NULL,
  additional_info TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_charges_bill ON bill_finance_charges(bill_public_id);

-- Limites desagregados do cartão. NÃO são somados ao total: são recortes do
-- mesmo limite (docs/09 §5.1).
CREATE TABLE IF NOT EXISTS account_credit_limits (
  account_public_id             TEXT NOT NULL REFERENCES accounts(public_id) ON DELETE CASCADE,
  ordinal                       INTEGER NOT NULL CHECK (ordinal >= 0),
  credit_line_limit_type        TEXT,
  consolidation_type            TEXT,
  is_limit_flexible             INTEGER CHECK (is_limit_flexible IN (0,1)),
  used_amount_minor             INTEGER,
  limit_amount_minor            INTEGER,
  available_amount_minor        INTEGER,
  customized_limit_amount_minor INTEGER,
  currency_code                 TEXT,
  updated_at                    TEXT NOT NULL,
  PRIMARY KEY (account_public_id, ordinal)
);

-- Série recorrente detectada. A chave é CNPJ do merchant ou descrição
-- normalizada — nunca documento do pagador (docs/09 §6.1).
CREATE TABLE IF NOT EXISTS recurring_analysis (
  id                      TEXT PRIMARY KEY,
  matcher_type            TEXT NOT NULL CHECK (matcher_type IN ('MERCHANT_CNPJ','DESCRIPTION_RAW_NORMALIZED')),
  matcher_value           TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  cadence                 TEXT NOT NULL CHECK (cadence IN ('WEEKLY','MONTHLY','BIMONTHLY','QUARTERLY','ANNUAL')),
  median_interval_days    INTEGER,
  median_amount_minor     INTEGER,
  annualized_cost_minor   INTEGER,
  next_expected_date      TEXT,
  last_occurrence_date    TEXT,
  category_id             TEXT,
  currency_code           TEXT NOT NULL DEFAULT 'BRL',
  status                  TEXT NOT NULL CHECK (status IN ('ACTIVE','DORMANT','RESUMED')),
  regularity_score        INTEGER NOT NULL CHECK (regularity_score BETWEEN 0 AND 10000),
  amount_stability_score  INTEGER NOT NULL CHECK (amount_stability_score BETWEEN 0 AND 10000),
  last_gap_days           INTEGER CHECK (last_gap_days IS NULL OR last_gap_days >= 0),
  resumed_at              TEXT,
  analysis_version        TEXT NOT NULL,
  active                  INTEGER NOT NULL CHECK (active IN (0,1)),
  price_increase_detected INTEGER NOT NULL DEFAULT 0 CHECK (price_increase_detected IN (0,1)),
  price_base_minor        INTEGER,
  price_current_minor     INTEGER,
  price_window_size       INTEGER,
  confidence              TEXT NOT NULL CHECK (confidence IN ('LOW','MEDIUM','HIGH')),
  analyzed_at             TEXT NOT NULL,
  CHECK ((status IN ('ACTIVE','RESUMED') AND active = 1)
      OR (status = 'DORMANT' AND active = 0)),
  CHECK ((status = 'RESUMED' AND resumed_at IS NOT NULL) OR status <> 'RESUMED'),
  UNIQUE (matcher_type, matcher_value)
);
CREATE INDEX IF NOT EXISTS idx_recurring_active_next
  ON recurring_analysis(active, next_expected_date);

CREATE TABLE IF NOT EXISTS recurring_occurrences (
  recurring_id          TEXT NOT NULL REFERENCES recurring_analysis(id) ON DELETE CASCADE,
  transaction_public_id TEXT NOT NULL REFERENCES transactions(public_id) ON DELETE CASCADE,
  matched_at            TEXT NOT NULL,
  PRIMARY KEY (recurring_id, transaction_public_id)
);

-- Campos que a F3 precisa da transação. billForecastDate chega como YYYY-MM
-- no tenant medido; guardamos o texto original sem inventar dia.
ALTER TABLE transactions ADD COLUMN bill_forecast_date TEXT;
ALTER TABLE transactions ADD COLUMN merchant_cnpj TEXT;
ALTER TABLE transactions ADD COLUMN merchant_business_name TEXT;
ALTER TABLE transactions ADD COLUMN description_raw_normalized TEXT;
ALTER TABLE transactions ADD COLUMN payee_mcc INTEGER;
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_cnpj
  ON transactions(merchant_cnpj) WHERE merchant_cnpj IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_description_normalized
  ON transactions(description_raw_normalized) WHERE description_raw_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_bill_forecast
  ON transactions(account_public_id, bill_forecast_date);

-- Metadados do cartão na conta (nunca o número).
ALTER TABLE accounts ADD COLUMN credit_level TEXT;
ALTER TABLE accounts ADD COLUMN credit_brand TEXT;
ALTER TABLE accounts ADD COLUMN balance_due_date TEXT;
ALTER TABLE accounts ADD COLUMN balance_close_date TEXT;
ALTER TABLE accounts ADD COLUMN minimum_payment REAL;
ALTER TABLE accounts ADD COLUMN credit_status TEXT;

ALTER TABLE credit_card_bills ADD COLUMN allows_installments INTEGER;
`,
};
