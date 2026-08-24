# Modelo de dados

## 1. Decisões estruturais

O PulsoFinanceiro usa um único arquivo SQLite no diretório de bancos da casa. O volume medido — cerca de 2,1 mil transações por ano, um usuário e nenhuma concorrência relevante de escrita — não justifica manter Postgres, container ou porta adicionais.

Regras do banco:

- SQLite **3.24 ou superior**, para `ON CONFLICT DO UPDATE`, com extensão JSON1;
- `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, `PRAGMA synchronous=NORMAL` e `PRAGMA busy_timeout=5000` em toda conexão;
- um writer por vez; jobs de sync mantêm transações curtas, por página;
- timestamps como texto RFC 3339 em UTC, com sufixo `Z`;
- datas civis (`due_date`, `snapshot_date`) como `YYYY-MM-DD`;
- booleanos como `INTEGER NOT NULL CHECK (... IN (0,1))`;
- valores monetários como inteiro em unidade mínima (`*_minor`) acompanhado de `currency_code`; para BRL, R$ 42,75 vira `4275`;
- conversão monetária com decimal exato antes do insert, nunca com arredondamento de `float` binário;
- IDs externos da Pluggy como `TEXT`; `accounts` e `transactions` também recebem `public_id` ULID aleatório, estável e `UNIQUE`, gerado localmente uma única vez e nunca derivado do ID externo;
- nenhuma tabela `users`, sessão ou credencial de usuário. O produto é single-user e a proteção humana fica na borda.

O banco local contém informação financeira privada e nunca é versionado. Backups preservam o arquivo SQLite e, quando a cópia for feita online, usam a API de backup do SQLite ou `VACUUM INTO`, não uma cópia cega que ignore o WAL.

## 2. Política de PII

### Decisão: remoção, não hash

O JSON bruto de cada transação é útil para auditoria e evolução do mapeador, mas é persistido somente após sanitização recursiva. A decisão é **remover CPF**, não hasheá-lo: o projeto não tem caso de uso para correlação por CPF, e um hash de um domínio pequeno e formatado continua sujeito a enumeração e cria um identificador permanente desnecessário.

Existe uma única denylist canônica para todo payload Pluggy. Nunca persistir, em coluna normalizada ou JSON:

- os subtrees `paymentData.payer.documentNumber` e `paymentData.receiver.documentNumber`;
- chaves `owner`, `taxNumber`, `number`, `cardNumber`, `identificationNumber` e `identity`, em qualquer profundidade.

O endpoint `/identity` não é consumido nesta fase. A chave `identity` permanece na denylist mesmo em outros endpoints: um payload aditivo não pode reintroduzir seus dados por outro caminho.

O sanitizador percorre objetos e arrays antes de qualquer insert, log, cache ou tratamento de erro. Depois dele, uma validação de negação reprova o payload se as chaves proibidas ainda existirem. Não se grava valor mascarado, hash, últimos dígitos ou cópia “temporária”.

`merchant.cnpj` é a única exceção empresarial aprovada: pode permanecer no SQLite local para agrupamento e regras de categoria. Ele nunca entra em prompt/saída de IA, log, telemetria, exemplo, fixture, export ou repositório público. O mesmo cuidado vale para `descriptionRaw` e `merchant.businessName`, que revelam comportamento financeiro e ficam restritos ao banco e à UI protegida.

Contrato ilustrativo do sanitizador:

```text
sanitize(value, path):
  se a chave atual estiver em {owner, taxNumber, number, cardNumber, identificationNumber, identity}: remover
  se path começar por paymentData.payer.documentNumber ou paymentData.receiver.documentNumber: remover o objeto inteiro
  se for array: sanitizar cada elemento
  se for objeto: sanitizar recursivamente cada propriedade
  ao final: assert nenhuma chave proibida existe
```

Alternativa descartada: criptografar apenas o CPF dentro do JSON. Isso preservaria um dado sem uso e criaria mais uma chave para operar, rotacionar e potencialmente vazar.

## 3. Relações principais

```text
items 1 ── N accounts 1 ── N transactions
  │             │               ├── 0..1 transaction_overrides
  │             │               ├── N transaction_clarifications
  │             │               ├── N transaction_bill_payment_matches
  │             │               └── N recurring_occurrences
  │             ├── N account_credit_limits
  │             ├── N credit_card_bills ── N bill_finance_charges
  │             │                        └── N bill_payments ── N transaction_bill_payment_matches
  │             └── N balance_snapshots
  ├── N investments
  ├── N loans
  ├── N sync_runs ── N sync_run_sources
  └── N outbox_events

categories 1 ── N transactions
categories 1 ── N category_overrides
transaction_alias_rules ── aliases reaplicáveis somente por matcher seguro
transaction_context_rules ── contexto reaplicável por fingerprint versionada e escopada à conta
transaction_context_rule_applications ── trilha de cada reaplicação e eventual correção
webhook_inbox ── eventos idempotentes por event_id
transaction_tombstones ── deletes conhecidos ou ainda sem linha de transação
recurring_analysis 1 ── N recurring_occurrences
ai_cache / ai_usage ── contexto sanitizado e contabilidade de custo
system_state ── revisão monotônica dos dados servidos pela API
```

## 4. Schema SQLite canônico

O bloco abaixo é o contrato de nomes e restrições para as migrations da rodada de implementação. É documentação; não substitui arquivos de migration versionados.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  applied_at    TEXT NOT NULL
);

CREATE TABLE items (
  id                       TEXT PRIMARY KEY,
  connector_id             TEXT,
  status                   TEXT NOT NULL,
  execution_status         TEXT,
  last_updated_at          TEXT,
  next_auto_sync_at        TEXT,
  consent_expires_at       TEXT,
  last_error_code          TEXT,
  last_error_message       TEXT,
  first_seen_at            TEXT NOT NULL,
  last_seen_at             TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE accounts (
  id                                      TEXT PRIMARY KEY,
  public_id                               TEXT NOT NULL UNIQUE,
  item_id                                 TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  type                                    TEXT NOT NULL CHECK (type IN ('BANK','CREDIT')),
  subtype                                 TEXT NOT NULL,
  display_name                            TEXT NOT NULL,
  currency_code                           TEXT NOT NULL CHECK (length(currency_code) = 3),
  balance_minor                           INTEGER,
  bank_closing_balance_minor              INTEGER,
  automatically_invested_balance_minor    INTEGER,
  overdraft_contracted_limit_minor        INTEGER,
  overdraft_used_limit_minor              INTEGER,
  unarranged_overdraft_amount_minor       INTEGER,
  credit_level                            TEXT,
  credit_brand                            TEXT,
  credit_limit_minor                      INTEGER,
  available_credit_limit_minor            INTEGER,
  balance_due_date                        TEXT,
  balance_close_date                      TEXT,
  minimum_payment_minor                   INTEGER,
  credit_status                           TEXT,
  holder_type                             TEXT,
  first_seen_at                           TEXT NOT NULL,
  last_seen_at                            TEXT NOT NULL,
  deleted_at                              TEXT,
  updated_at                              TEXT NOT NULL
);

CREATE TABLE account_credit_limits (
  account_id                       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ordinal                          INTEGER NOT NULL CHECK (ordinal >= 0),
  credit_line_limit_type           TEXT,
  consolidation_type               TEXT,
  is_limit_flexible                INTEGER CHECK (is_limit_flexible IN (0,1)),
  line_name                        TEXT,
  line_name_additional_info        TEXT,
  used_amount_minor                INTEGER,
  limit_amount_minor               INTEGER,
  customized_limit_amount_minor    INTEGER,
  available_amount_minor           INTEGER,
  currency_code                    TEXT CHECK (currency_code IS NULL OR length(currency_code) = 3),
  updated_at                       TEXT NOT NULL,
  PRIMARY KEY (account_id, ordinal)
);

CREATE TABLE categories (
  id                       TEXT PRIMARY KEY CHECK (length(id) = 8),
  description              TEXT NOT NULL,
  description_translated   TEXT NOT NULL,
  parent_id                TEXT REFERENCES categories(id) DEFERRABLE INITIALLY DEFERRED,
  parent_description       TEXT,
  level1_prefix            TEXT NOT NULL CHECK (length(level1_prefix) = 2),
  synced_at                TEXT NOT NULL
);

CREATE TABLE category_overrides (
  id                 TEXT PRIMARY KEY,
  matcher_type       TEXT NOT NULL CHECK (matcher_type IN ('MERCHANT_CNPJ','DESCRIPTION_RAW_NORMALIZED')),
  matcher_value      TEXT NOT NULL,
  category_id        TEXT NOT NULL REFERENCES categories(id),
  origin             TEXT NOT NULL CHECK (origin IN ('SUGGESTION_ACCEPTED','USER_ADJUSTED','HERMES_CLARIFICATION')),
  source_clarification_id TEXT REFERENCES transaction_clarifications(id) ON DELETE RESTRICT,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (matcher_type, matcher_value),
  CHECK ((origin = 'HERMES_CLARIFICATION' AND source_clarification_id IS NOT NULL)
      OR (origin <> 'HERMES_CLARIFICATION' AND source_clarification_id IS NULL))
);

CREATE TABLE transactions (
  id                                TEXT PRIMARY KEY,
  public_id                         TEXT NOT NULL UNIQUE,
  account_id                        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  description                       TEXT,
  description_raw                   TEXT,
  description_raw_normalized        TEXT,
  currency_code                     TEXT NOT NULL CHECK (length(currency_code) = 3),
  amount_minor                      INTEGER NOT NULL,
  amount_in_account_currency_minor  INTEGER,
  transaction_date                  TEXT NOT NULL,
  category_id                       TEXT REFERENCES categories(id),
  local_category_id                 TEXT REFERENCES categories(id),
  category_label_source             TEXT,
  balance_minor                     INTEGER,
  provider_code                     TEXT,
  provider_id                       TEXT,
  status                            TEXT NOT NULL CHECK (status IN ('POSTED','PENDING')),
  type                              TEXT NOT NULL CHECK (type IN ('DEBIT','CREDIT')),
  operation_type                    TEXT,
  operation_type_additional_info    TEXT,
  transaction_order                 INTEGER,
  payee_mcc                         INTEGER,
  bill_forecast_date                TEXT,
  merchant_cnpj                     TEXT,
  merchant_cnae                     TEXT,
  merchant_category                 TEXT,
  merchant_business_name            TEXT,
  is_internal_transfer_derived      INTEGER NOT NULL DEFAULT 0 CHECK (is_internal_transfer_derived IN (0,1)),
  source_created_at                 TEXT,
  source_updated_at                 TEXT,
  version_revision                  INTEGER NOT NULL DEFAULT 1 CHECK (version_revision >= 1),
  raw_json_sanitized                TEXT NOT NULL CHECK (json_valid(raw_json_sanitized)),
  first_seen_at                     TEXT NOT NULL,
  last_seen_at                      TEXT NOT NULL,
  last_reconciliation_epoch         TEXT,
  deleted_at                        TEXT,
  deleted_event_id                  TEXT,
  updated_at                        TEXT NOT NULL
);

CREATE TABLE transaction_overrides (
  transaction_id        TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  is_internal_transfer  INTEGER NOT NULL CHECK (is_internal_transfer IN (0,1)),
  origin                TEXT NOT NULL DEFAULT 'USER_ONE_CLICK' CHECK (origin = 'USER_ONE_CLICK'),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE credit_card_bills (
  id                           TEXT PRIMARY KEY,
  account_id                   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  due_date                     TEXT NOT NULL,
  bill_closing_date            TEXT,
  total_amount_minor           INTEGER NOT NULL,
  currency_code                TEXT NOT NULL CHECK (length(currency_code) = 3),
  minimum_payment_amount_minor INTEGER,
  allows_installments          INTEGER CHECK (allows_installments IN (0,1)),
  first_seen_at                TEXT NOT NULL,
  last_seen_at                 TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);

CREATE TABLE bill_finance_charges (
  id               TEXT PRIMARY KEY,
  bill_id          TEXT NOT NULL REFERENCES credit_card_bills(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL,
  currency_code    TEXT NOT NULL CHECK (length(currency_code) = 3),
  additional_info  TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE bill_payments (
  id               TEXT PRIMARY KEY,
  bill_id          TEXT NOT NULL REFERENCES credit_card_bills(id) ON DELETE CASCADE,
  value_type       TEXT,
  payment_date     TEXT,
  payment_mode     TEXT,
  amount_minor     INTEGER NOT NULL,
  currency_code    TEXT NOT NULL CHECK (length(currency_code) = 3),
  updated_at       TEXT NOT NULL
);

CREATE TABLE transaction_bill_payment_matches (
  id                 TEXT PRIMARY KEY,
  bill_payment_id    TEXT NOT NULL REFERENCES bill_payments(id) ON DELETE CASCADE,
  transaction_id     TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('BANK_DEBIT','CARD_CREDIT')),
  confidence         TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM')),
  evidence_json      TEXT NOT NULL CHECK (json_valid(evidence_json)),
  algorithm_version  TEXT NOT NULL,
  matched_at         TEXT NOT NULL,
  UNIQUE (bill_payment_id, role),
  UNIQUE (transaction_id, role)
);

CREATE TABLE investments (
  id                       TEXT PRIMARY KEY,
  item_id                  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  type                     TEXT NOT NULL,
  subtype                  TEXT,
  display_name             TEXT NOT NULL,
  code                     TEXT,
  isin                     TEXT,
  currency_code            TEXT CHECK (currency_code IS NULL OR length(currency_code) = 3),
  balance_minor            INTEGER,
  amount_minor             INTEGER,
  amount_profit_minor      INTEGER,
  amount_withdrawal_minor  INTEGER,
  quantity_decimal         TEXT,
  status                   TEXT,
  source_date              TEXT,
  raw_json_sanitized       TEXT CHECK (raw_json_sanitized IS NULL OR json_valid(raw_json_sanitized)),
  first_seen_at            TEXT NOT NULL,
  last_seen_at             TEXT NOT NULL,
  deleted_at               TEXT,
  updated_at               TEXT NOT NULL
);

CREATE TABLE loans (
  id                         TEXT PRIMARY KEY,
  item_id                    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  account_id                 TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  type                       TEXT,
  subtype                    TEXT,
  display_name               TEXT,
  currency_code              TEXT CHECK (currency_code IS NULL OR length(currency_code) = 3),
  contracted_amount_minor    INTEGER,
  outstanding_balance_minor INTEGER,
  installment_amount_minor  INTEGER,
  contracted_at              TEXT,
  due_at                     TEXT,
  status                     TEXT,
  raw_json_sanitized         TEXT CHECK (raw_json_sanitized IS NULL OR json_valid(raw_json_sanitized)),
  first_seen_at              TEXT NOT NULL,
  last_seen_at               TEXT NOT NULL,
  deleted_at                 TEXT,
  updated_at                 TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id                       TEXT PRIMARY KEY,
  item_id                  TEXT REFERENCES items(id) ON DELETE SET NULL,
  trigger                  TEXT NOT NULL CHECK (trigger IN ('INITIAL','WEBHOOK','SCHEDULED','ON_DEMAND')),
  mode                     TEXT NOT NULL CHECK (mode IN ('INCREMENTAL','FULL','TARGETED')),
  status                   TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','PARTIAL','SKIPPED')),
  started_at               TEXT NOT NULL,
  finished_at              TEXT,
  pages_read               INTEGER NOT NULL DEFAULT 0,
  records_received         INTEGER NOT NULL DEFAULT 0,
  inserted_count           INTEGER NOT NULL DEFAULT 0,
  updated_count            INTEGER NOT NULL DEFAULT 0,
  tombstoned_count         INTEGER NOT NULL DEFAULT 0,
  pending_count            INTEGER NOT NULL DEFAULT 0,
  error_code               TEXT,
  error_message            TEXT,
  CHECK ((trigger = 'INITIAL' AND mode = 'FULL')
      OR (trigger = 'WEBHOOK' AND mode = 'TARGETED')
      OR (trigger = 'SCHEDULED' AND mode IN ('INCREMENTAL','FULL'))
      OR (trigger = 'ON_DEMAND' AND mode = 'FULL'))
);

CREATE TABLE sync_state (
  source_key                  TEXT PRIMARY KEY,
  item_id                     TEXT REFERENCES items(id) ON DELETE CASCADE,
  account_id                  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  source_type                 TEXT NOT NULL CHECK (source_type IN ('TRANSACTIONS','BILLS','ACCOUNTS','CATEGORIES','INVESTMENTS','LOANS','ITEM')),
  last_successful_at          TEXT,
  created_at_watermark        TEXT,
  resume_next_query           TEXT,
  resume_run_id               TEXT REFERENCES sync_runs(id) ON DELETE SET NULL,
  reconciliation_epoch        TEXT,
  last_reconciled_at          TEXT,
  last_observed_source_at     TEXT,
  consecutive_failures        INTEGER NOT NULL DEFAULT 0,
  lease_owner                 TEXT,
  lease_until                 TEXT,
  last_error_code             TEXT,
  last_error_at               TEXT,
  updated_at                  TEXT NOT NULL,
  UNIQUE (source_type, item_id, account_id)
);

CREATE TABLE sync_run_sources (
  sync_run_id       TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  source_key        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  pages_read        INTEGER NOT NULL DEFAULT 0,
  records_received INTEGER NOT NULL DEFAULT 0,
  watermark_from    TEXT,
  watermark_to      TEXT,
  reconciliation_epoch TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  error_code        TEXT,
  PRIMARY KEY (sync_run_id, source_key)
);

CREATE TABLE transaction_tombstones (
  external_transaction_id  TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tombstone_source         TEXT NOT NULL CHECK (tombstone_source IN ('WEBHOOK','RECONCILIATION')),
  deleted_event_id         TEXT,
  deleted_at               TEXT NOT NULL,
  cleared_at               TEXT,
  cleared_by_run_id        TEXT REFERENCES sync_runs(id) ON DELETE SET NULL,
  clear_reason             TEXT CHECK (clear_reason IS NULL OR clear_reason = 'AUTHORITATIVE_CURRENT_READ'),
  CHECK ((tombstone_source = 'WEBHOOK' AND deleted_event_id IS NOT NULL)
      OR tombstone_source = 'RECONCILIATION')
);

CREATE TABLE balance_snapshots (
  id                                      TEXT PRIMARY KEY,
  account_id                              TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sync_run_id                             TEXT REFERENCES sync_runs(id) ON DELETE SET NULL,
  snapshot_date                           TEXT NOT NULL,
  captured_at                             TEXT NOT NULL,
  balance_minor                           INTEGER,
  closing_balance_minor                   INTEGER,
  automatically_invested_balance_minor    INTEGER,
  credit_limit_minor                      INTEGER,
  available_credit_limit_minor            INTEGER,
  open_bill_amount_minor                  INTEGER,
  open_bill_due_date                      TEXT,
  open_bill_currency_code                 TEXT CHECK (open_bill_currency_code IS NULL OR length(open_bill_currency_code) = 3),
  open_bill_source                        TEXT NOT NULL CHECK (open_bill_source IN ('BILLS','TRANSACTIONS_FALLBACK','UNAVAILABLE')),
  open_bill_quality                       TEXT NOT NULL CHECK (open_bill_quality IN ('COMPLETE','PARTIAL','UNAVAILABLE')),
  currency_code                           TEXT NOT NULL CHECK (length(currency_code) = 3),
  UNIQUE (account_id, snapshot_date)
);

CREATE TABLE webhook_inbox (
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

CREATE TABLE recurring_analysis (
  id                       TEXT PRIMARY KEY,
  matcher_type             TEXT NOT NULL CHECK (matcher_type IN ('MERCHANT_CNPJ','DESCRIPTION_RAW_NORMALIZED')),
  matcher_value            TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  cadence                  TEXT NOT NULL CHECK (cadence IN ('WEEKLY','MONTHLY','BIMONTHLY','QUARTERLY','ANNUAL')),
  median_interval_days     INTEGER,
  median_amount_minor      INTEGER,
  amount_variation_ratio   TEXT,
  annualized_cost_minor    INTEGER,
  next_expected_date       TEXT,
  last_occurrence_date     TEXT,
  status                   TEXT NOT NULL CHECK (status IN ('ACTIVE','DORMANT','RESUMED')),
  regularity_score         INTEGER NOT NULL CHECK (regularity_score BETWEEN 0 AND 10000),
  amount_stability_score   INTEGER NOT NULL CHECK (amount_stability_score BETWEEN 0 AND 10000),
  last_gap_days            INTEGER CHECK (last_gap_days IS NULL OR last_gap_days >= 0),
  resumed_at               TEXT,
  analysis_version         TEXT NOT NULL,
  active                   INTEGER NOT NULL CHECK (active IN (0,1)),
  price_increase_detected  INTEGER NOT NULL DEFAULT 0 CHECK (price_increase_detected IN (0,1)),
  confidence               TEXT NOT NULL CHECK (confidence IN ('LOW','MEDIUM','HIGH')),
  analyzed_at              TEXT NOT NULL,
  CHECK ((status IN ('ACTIVE','RESUMED') AND active = 1)
      OR (status = 'DORMANT' AND active = 0)),
  CHECK ((status = 'RESUMED' AND resumed_at IS NOT NULL) OR status <> 'RESUMED'),
  UNIQUE (matcher_type, matcher_value)
);

CREATE TABLE recurring_occurrences (
  recurring_id   TEXT NOT NULL REFERENCES recurring_analysis(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  matched_at     TEXT NOT NULL,
  PRIMARY KEY (recurring_id, transaction_id)
);

CREATE TABLE ai_usage (
  id                       TEXT PRIMARY KEY,
  use_case                 TEXT NOT NULL,
  prompt_version           TEXT NOT NULL,
  model                    TEXT NOT NULL,
  fallback_model           TEXT,
  input_tokens             INTEGER,
  output_tokens            INTEGER,
  estimated_cost_micro_usd INTEGER,
  cache_hit                INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0,1)),
  metric_refs_json         TEXT NOT NULL CHECK (json_valid(metric_refs_json)),
  status                   TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  error_code               TEXT,
  started_at               TEXT NOT NULL,
  finished_at              TEXT
);

CREATE TABLE ai_cache (
  cache_key         TEXT PRIMARY KEY,
  use_case          TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  model             TEXT NOT NULL,
  context_hash      TEXT NOT NULL,
  response_json     TEXT NOT NULL CHECK (json_valid(response_json)),
  metric_refs_json  TEXT NOT NULL CHECK (json_valid(metric_refs_json)),
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  last_accessed_at  TEXT NOT NULL
);

CREATE TABLE service_principals (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  current_token_hash    TEXT NOT NULL UNIQUE,
  next_token_hash       TEXT UNIQUE,
  scopes_json           TEXT NOT NULL CHECK (json_valid(scopes_json)),
  active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  rotation_started_at   TEXT,
  current_accept_until  TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT,
  last_used_at          TEXT,
  revoked_at            TEXT,
  updated_at            TEXT NOT NULL,
  CHECK ((next_token_hash IS NULL AND rotation_started_at IS NULL AND current_accept_until IS NULL)
      OR (next_token_hash IS NOT NULL AND rotation_started_at IS NOT NULL AND current_accept_until IS NOT NULL)),
  CHECK (next_token_hash IS NULL OR next_token_hash <> current_token_hash)
);

CREATE TABLE transaction_clarifications (
  id                             TEXT PRIMARY KEY,
  public_id                      TEXT NOT NULL UNIQUE,
  transaction_id                 TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  transaction_source_updated_at  TEXT,
  transaction_revision_key       TEXT NOT NULL,
  source_context_rule_id         TEXT REFERENCES transaction_context_rules(id) ON DELETE RESTRICT,
  status                         TEXT NOT NULL CHECK (status IN ('PENDING','RESOLVED','EXPIRED')),
  reason_codes_json              TEXT NOT NULL CHECK (json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'),
  suggested_categories_json      TEXT NOT NULL CHECK (json_valid(suggested_categories_json) AND json_type(suggested_categories_json) = 'array'),
  question_version               TEXT NOT NULL,
  similar_matcher_kind           TEXT CHECK (similar_matcher_kind IS NULL OR similar_matcher_kind IN ('MERCHANT_CNPJ','DESCRIPTION_RAW_NORMALIZED','SOURCE_FINGERPRINT_V1')),
  similar_matcher_confidence     TEXT CHECK (similar_matcher_confidence IS NULL OR similar_matcher_confidence = 'HIGH'),
  resolution_kind                TEXT CHECK (resolution_kind IS NULL OR resolution_kind IN ('CATEGORY_ONLY','CATEGORY_OVERRIDE','NORMALIZED_ALIAS')),
  resolved_category_id           TEXT REFERENCES categories(id),
  normalized_alias               TEXT,
  apply_to_similar               INTEGER CHECK (apply_to_similar IS NULL OR apply_to_similar IN (0,1)),
  resolved_by_principal_id       TEXT REFERENCES service_principals(id),
  resolution_idempotency_key_hash TEXT UNIQUE,
  resolution_request_hash        TEXT,
  created_at                     TEXT NOT NULL,
  expires_at                     TEXT NOT NULL,
  resolved_at                    TEXT,
  updated_at                     TEXT NOT NULL,
  UNIQUE (transaction_id, transaction_revision_key),
  CHECK ((status = 'RESOLVED' AND resolution_kind IS NOT NULL AND apply_to_similar IS NOT NULL AND resolved_by_principal_id IS NOT NULL AND resolution_idempotency_key_hash IS NOT NULL AND resolution_request_hash IS NOT NULL AND resolved_at IS NOT NULL
          AND ((resolution_kind IN ('CATEGORY_ONLY','CATEGORY_OVERRIDE') AND resolved_category_id IS NOT NULL AND normalized_alias IS NULL)
            OR (resolution_kind = 'NORMALIZED_ALIAS' AND normalized_alias IS NOT NULL)))
      OR (status <> 'RESOLVED' AND resolution_kind IS NULL AND resolved_category_id IS NULL AND normalized_alias IS NULL AND apply_to_similar IS NULL AND resolved_by_principal_id IS NULL AND resolution_idempotency_key_hash IS NULL AND resolution_request_hash IS NULL AND resolved_at IS NULL)),
  CHECK ((similar_matcher_kind IS NULL AND similar_matcher_confidence IS NULL)
      OR (similar_matcher_kind IS NOT NULL AND similar_matcher_confidence = 'HIGH')),
  CHECK (apply_to_similar IS NULL OR apply_to_similar = 0 OR similar_matcher_kind IS NOT NULL),
  CHECK (resolution_kind = 'NORMALIZED_ALIAS' OR normalized_alias IS NULL),
  CHECK (resolution_kind <> 'NORMALIZED_ALIAS' OR normalized_alias IS NOT NULL)
);

CREATE TABLE transaction_alias_rules (
  id                       TEXT PRIMARY KEY,
  matcher_type             TEXT NOT NULL CHECK (matcher_type IN ('MERCHANT_CNPJ','DESCRIPTION_RAW_NORMALIZED')),
  matcher_value            TEXT NOT NULL,
  normalized_alias         TEXT NOT NULL,
  source_clarification_id  TEXT NOT NULL REFERENCES transaction_clarifications(id),
  origin                   TEXT NOT NULL CHECK (origin = 'HERMES_CLARIFICATION'),
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (matcher_type, matcher_value)
);

CREATE TABLE transaction_context_rules (
  id                       TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  fingerprint_version      TEXT NOT NULL CHECK (fingerprint_version = 'SOURCE_FINGERPRINT_V1'),
  fingerprint_hash         TEXT NOT NULL CHECK (
    length(fingerprint_hash) = 64
    AND fingerprint_hash = lower(fingerprint_hash)
    AND fingerprint_hash NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_codes_json      TEXT NOT NULL CHECK (json_valid(evidence_codes_json) AND json_type(evidence_codes_json) = 'array'),
  direction                TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  currency_code            TEXT NOT NULL CHECK (length(currency_code) = 3),
  amount_center_minor      INTEGER NOT NULL CHECK (amount_center_minor <> 0),
  amount_tolerance_minor   INTEGER NOT NULL DEFAULT 0 CHECK (
    amount_tolerance_minor >= 0
    AND amount_tolerance_minor <= 100
    AND amount_tolerance_minor * 100 <= abs(amount_center_minor)
  ),
  resolved_category_id     TEXT REFERENCES categories(id),
  normalized_alias         TEXT CHECK (normalized_alias IS NULL OR length(normalized_alias) BETWEEN 1 AND 60),
  confidence               TEXT NOT NULL CHECK (confidence = 'HIGH'),
  source_clarification_id  TEXT NOT NULL REFERENCES transaction_clarifications(id) ON DELETE RESTRICT,
  origin                   TEXT NOT NULL CHECK (origin = 'HERMES_CLARIFICATION'),
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  match_count              INTEGER NOT NULL DEFAULT 0 CHECK (match_count >= 0),
  correction_count         INTEGER NOT NULL DEFAULT 0 CHECK (correction_count >= 0),
  last_matched_at          TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (account_id, fingerprint_version, fingerprint_hash, direction, currency_code, amount_center_minor),
  CHECK (resolved_category_id IS NOT NULL OR normalized_alias IS NOT NULL)
);

CREATE TABLE transaction_context_rule_applications (
  id                          TEXT PRIMARY KEY,
  transaction_id              TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  context_rule_id              TEXT NOT NULL REFERENCES transaction_context_rules(id) ON DELETE RESTRICT,
  transaction_revision_key     TEXT NOT NULL,
  applied_category_id          TEXT REFERENCES categories(id),
  applied_alias                TEXT,
  status                       TEXT NOT NULL CHECK (status IN ('APPLIED','CORRECTED','SUPERSEDED')),
  review_clarification_id      TEXT REFERENCES transaction_clarifications(id) ON DELETE RESTRICT,
  correction_clarification_id  TEXT REFERENCES transaction_clarifications(id) ON DELETE RESTRICT,
  applied_at                   TEXT NOT NULL,
  corrected_at                 TEXT,
  updated_at                   TEXT NOT NULL,
  UNIQUE (transaction_id, transaction_revision_key),
  CHECK (applied_category_id IS NOT NULL OR applied_alias IS NOT NULL),
  CHECK ((status = 'CORRECTED' AND correction_clarification_id IS NOT NULL AND corrected_at IS NOT NULL)
      OR (status <> 'CORRECTED' AND correction_clarification_id IS NULL AND corrected_at IS NULL))
);

CREATE TABLE system_state (
  singleton_id   INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  data_revision  INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0),
  updated_at     TEXT NOT NULL
);

CREATE TABLE outbox_events (
  id                TEXT PRIMARY KEY,
  item_id           TEXT REFERENCES items(id) ON DELETE SET NULL,
  event_type        TEXT NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','HIGH','CRITICAL')),
  schema_version    INTEGER NOT NULL DEFAULT 1,
  payload_json      TEXT NOT NULL CHECK (json_valid(payload_json)),
  dedup_key         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('PENDING','LEASED','DELIVERED','DISMISSED','DEAD_LETTER')),
  occurred_at       TEXT NOT NULL,
  last_occurred_at  TEXT NOT NULL,
  occurrence_count  INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  condition_closed_at TEXT,
  available_at      TEXT NOT NULL,
  lease_owner       TEXT REFERENCES service_principals(id),
  lease_until       TEXT,
  lease_token_hash  TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  delivery_id       TEXT UNIQUE,
  delivery_principal_id TEXT REFERENCES service_principals(id),
  ack_request_hash  TEXT,
  delivered_at      TEXT,
  dismissed_reason_code TEXT CHECK (dismissed_reason_code IS NULL OR dismissed_reason_code IN ('POLICY_SUPPRESSED','NO_AUTHORIZED_CHANNEL','SUPERSEDED_BY_NEWER_EVENT')),
  dismissed_at      TEXT,
  last_error_code   TEXT,
  updated_at        TEXT NOT NULL,
  CHECK ((status = 'LEASED' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND lease_token_hash IS NOT NULL)
      OR (status <> 'LEASED' AND lease_owner IS NULL AND lease_until IS NULL AND lease_token_hash IS NULL)),
  CHECK ((status = 'DELIVERED' AND delivery_id IS NOT NULL AND delivery_principal_id IS NOT NULL AND ack_request_hash IS NOT NULL AND delivered_at IS NOT NULL AND dismissed_reason_code IS NULL AND dismissed_at IS NULL)
      OR (status = 'DISMISSED' AND delivery_id IS NOT NULL AND delivery_principal_id IS NOT NULL AND ack_request_hash IS NOT NULL AND delivered_at IS NULL AND dismissed_reason_code IS NOT NULL AND dismissed_at IS NOT NULL)
      OR (status NOT IN ('DELIVERED','DISMISSED') AND delivery_id IS NULL AND delivery_principal_id IS NULL AND ack_request_hash IS NULL AND delivered_at IS NULL AND dismissed_reason_code IS NULL AND dismissed_at IS NULL))
);

INSERT INTO system_state (singleton_id, data_revision, updated_at)
VALUES (1, 0, '1970-01-01T00:00:00Z');
```

## 5. Significado e regras por tabela

### `items`, `accounts` e `account_credit_limits`

`items` mantém apenas estado operacional. Não armazena payload bruto do Item nem duplica “último sync global”: a fonte canônica dessa informação é `sync_runs`. `accounts` achata os valores necessários aos widgets e aplica a denylist canônica antes do mapeamento.

`accounts.id` continua sendo o ID externo necessário às chamadas Pluggy. `accounts.public_id` é um ULID local, aleatório e imutável: o upsert procura por `id`, gera `public_id` somente no insert e nunca o troca no update. Rotas e DTOs humanos ou de agentes usam exclusivamente `public_id`; o ID externo não sai da camada de integração.

`account_credit_limits` é uma fotografia substituível de `disaggregatedCreditLimits[]`. Em cada sync da conta, apagar e reinserir somente as linhas dessa conta na mesma transação. A chave usa `ordinal`; `identificationNumber` não é persistido.

Conta que some da resposta não é apagada durante um incremental. Uma reconciliação completa pode preencher `deleted_at`, preservando histórico e FKs.

### `transactions`

`id` é a chave externa de idempotência. Campos da Pluggy são mutáveis: principalmente `status`, `amount`, categoria, descrição e metadados. `PENDING` deve virar `POSTED` na mesma linha. `public_id` segue a mesma regra das contas: ULID local aleatório gerado apenas no insert, preservado no `ON CONFLICT(id)` e único identificador permitido na API.

`version_revision` é a revisão local por transação. O mesmo commit a incrementa exatamente uma vez quando muda qualquer campo servido no DTO ou seu resultado efetivo: fonte/estado, categoria ou regra aplicada, transferência derivada/override, match de pagamento, classificação de crédito ou tombstone. Mudança alheia em outra transação não a incrementa. `version`/`If-Match` usa SHA-256 base64url de `public_id + NUL + version_revision`; o cliente trata o valor como opaco. A mesma revisão alimenta `transaction_revision_key` quando `source_updated_at` não bastar para representar alterações locais.

`raw_json_sanitized` é obrigatório e contém o objeto recebido depois da política de remoção. `local_category_id` representa a categoria efetiva aplicada por regra local; `category_id` conserva o valor da Pluggy. Consultas usam `COALESCE(local_category_id, category_id)`.

`is_internal_transfer_derived` vale 1 quando `category_id` começa por `04` ou a heurística local conclui uma correspondência. A heurística é conservadora e executável:

1. considera somente transações `POSTED`, não apagadas, em contas distintas do mesmo `item_id` e na mesma moeda;
2. exige uma saída e uma entrada com diferença entre os valores absolutos em `amount_in_account_currency` de no máximo uma unidade mínima da moeda — para BRL, R$ 0,01;
3. exige diferença temporal de no máximo 24 horas quando `date` tiver hora; se o provedor entregar apenas data civil, aceita somente o mesmo dia ou o dia adjacente em `America/Sao_Paulo`;
4. faz pareamento um-para-um. Vence o candidato com menor diferença temporal; `order` desempata. Se ainda houver empate ou mais de um pareamento igualmente plausível, nenhum lançamento é marcado automaticamente;
5. usa `operation_type`, contraparte sanitizada e descrição normalizada apenas para aumentar a confiança e resolver candidatos não empatados; esses sinais nunca relaxam valor, janela, contas distintas ou sentidos opostos.

O par é recalculado quando uma das transações muda. Uma correspondência automática marca as duas linhas; uma linha sem par fica 0. `transaction_overrides` guarda somente a decisão humana de um clique. O valor efetivo é `COALESCE(transaction_overrides.is_internal_transfer, transactions.is_internal_transfer_derived)`, e o override sempre vence a categoria ou heurística.

Todo delete de webhook faz upsert em `transaction_tombstones`, mesmo se a transação ainda for desconhecida. Se a linha existir, `transactions.deleted_at`/`deleted_event_id` são preenchidos na mesma transação como materialização para consultas. Um envelope atrasado de create/update **não** ressuscita a linha e o upsert genérico nunca limpa tombstone.

Somente uma leitura atual e autoritativa bem-sucedida de `/v2/transactions` que realmente devolva aquele ID pode, na mesma transação, preencher `transaction_tombstones.cleared_at`, `cleared_by_run_id`, `clear_reason = 'AUTHORITATIVE_CURRENT_READ'` e limpar a materialização em `transactions`. O worker não usa conteúdo antigo do envelope como prova. A Pluggy alerta que, após mudanças grandes, pode emitir delete do ID antigo e create de um novo: o modelo suporta ambos sem tentar uni-los por heurística.

### `categories` e `category_overrides`

`categories` é espelho de `GET /categories`. A sincronização ocorre antes das transações. Se uma transação trouxer categoria ainda ausente, sincronizar o catálogo novamente; somente depois, se continuar desconhecida, persistir a transação com `category_id = NULL` e manter o valor no JSON sanitizado, registrando drift de contrato.

`category_overrides` admite somente os dois matchers aprovados: CNPJ do merchant ou `descriptionRaw` normalizado. Ao aceitar/ajustar uma sugestão, o backend faz upsert da regra e recalcula `local_category_id` das transações compatíveis, sem formulário de lançamento manual. Origem `HERMES_CLARIFICATION` só é possível na fase futura, exige `source_clarification_id` e preserva qual decisão criou a regra; origens do site mantêm essa FK nula.

Alias não é categoria. `transaction_alias_rules` guarda separadamente o rótulo normalizado reaplicável e exige um dos mesmos matchers determinísticos. Quando existe CNPJ ou descrição reutilizável, essas regras continuam tendo precedência sobre qualquer inferência de contexto.

Para uma transação sem CNPJ/descrição reutilizável, `transaction_context_rules` permite cumprir o pedido de não perguntar novamente **somente** quando `SOURCE_FINGERPRINT_V1` produzir alta confiança. A entrada canônica combina conta interna, direção, moeda e pelo menos dois sinais estáveis independentes da allowlist `PROVIDER_CODE`, `OPERATION_TYPE`, `PAYEE_MCC`, `MERCHANT_CATEGORY` e `GENERALIZED_OPERATION_INFO`. O último é um código fechado obtido após remover PII e partes variáveis; nunca é o texto bruto. ID da transação/provedor, data, saldo, descrição, documento e nome não entram. O hash é SHA-256 hexadecimal da representação canônica versionada e fica apenas no SQLite protegido: não sai em DTO, evento, log, IA, Discord ou vault.

Valor não entra no hash: é um gate separado. A regra nasce com correspondência exata (`amount_tolerance_minor = 0`); tolerância futura exige evidência determinística, nunca pode passar de uma unidade monetária nem de 1% do centro, e exige nova calibração/versionamento se sua semântica mudar. Reaplicação exige a mesma conta, fingerprint, direção, moeda e faixa de valor. Colisão, sinais insuficientes ou conflito entre regras retorna baixa confiança e abre nova pergunta.

Cada reaplicação cria `transaction_context_rule_applications` antes de alterar `local_category_id`/alias derivado. Na **primeira** correspondência de uma regra, o backend cria uma clarificação de revisão com `reasonCodes = ['CONTEXT_RULE_REVIEW']`, `source_context_rule_id` e evento privado informativo `CONTEXT_RULE_FIRST_APPLIED`; ele diz “apliquei sua regra” e oferece corrigir, sem perguntar novamente o que é. Silêncio expira a revisão e mantém a aplicação. Se uma resolução vigente escolher categoria/alias diferente, o mesmo commit marca a aplicação `CORRECTED`, incrementa `correction_count`, desativa a regra antiga e aplica a nova decisão; regra substituta só nasce com nova escolha `applyToSimilar` e matcher seguro. Reativação nunca é automática.

Normalização de descrição: Unicode NFKC, caixa alta, trim, espaços repetidos reduzidos a um e remoção somente de sufixos variáveis previamente testados. O algoritmo e sua versão devem ser determinísticos; não remover números indiscriminadamente, pois parcelas e estabelecimentos podem depender deles.

### `credit_card_bills`, encargos e pagamentos

Uma fatura é atualizada por `bill.id`. `bill_finance_charges` sustenta o contador de IOF/juros; `bill_payments` permite avaliar liquidação. Em uma releitura completa de uma fatura, filhos ausentes na nova resposta são removidos dentro da transação da própria fatura, pois o pai continua como registro auditável.

`transaction_bill_payment_matches` liga cada pagamento informado em `bill_payments` às representações transacionais da mesma liquidação. O algoritmo é fechado e versionado:

1. só processa pagamento com `payment_date`, `amount_minor` e moeda válidos;
2. para `BANK_DEBIT`, candidatos são transações ativas `POSTED/DEBIT` de conta `BANK` do mesmo Item; para `CARD_CREDIT`, são transações ativas `POSTED/CREDIT` da mesma conta de cartão da fatura;
3. candidato precisa ter a mesma moeda, valor absoluto em moeda da conta **exatamente** igual ao valor absoluto de `bill_payments.amount_minor` e data civil em `America/Sao_Paulo` no mesmo dia ou a um dia de distância de `payment_date`;
4. em cada role, vence o único candidato com menor distância civil. Distância zero gera `HIGH`; distância de um dia gera `MEDIUM`. Empate no menor intervalo, candidato já ocupado por outro pagamento ou qualquer incompatibilidade deixa a role sem match — `order`, descrição ou merchant não desfazem ambiguidade;
5. `evidence_json` guarda apenas moeda, valores/deltas numéricos, distância em dias e referências locais opacas; nunca descrição, documento ou ID Pluggy. Reexecução da mesma `algorithm_version` substitui deterministicamente apenas seus matches derivados.

Transações presentes em qualquer role da tabela são liquidação e ficam fora de “gasto confirmado”. Crédito de cartão não pareado não é automaticamente estorno nem abatimento: permanece “ajuste não classificado”, não reduz gasto por suposição e faz o período retornar `quality = partial` até haver vínculo por outra regra auditável. Pagamento elegível com role ambígua também degrada a qualidade.

### Produtos atualmente vazios

`investments` e `loans` existem desde a primeira migration e a API interna devolve `[]` enquanto não houver registros. Os payloads futuros passam pelo mesmo sanitizador recursivo. Os campos `number` e `owner` conhecidos no produto Investment não aparecem no schema.

O contrato detalhado de Loans será fechado com uma amostra real antes de popular colunas; até lá, campos novos e seguros ficam em `raw_json_sanitized`, e qualquer chave proibida bloqueia o insert.

### Estado e auditoria de sincronização

`sync_runs` representa uma execução global; é a fonte de verdade para último sucesso global e aceita `SKIPPED` quando um lease já válido impede trabalho. `sync_run_sources` detalha conta/endpoint. `sync_state` é a fonte de verdade por fonte e mantém watermark confirmado, cursor opaco, run de retomada e epoch de reconciliação. O watermark só avança após todas as páginas da fonte concluírem; falha mantém o valor anterior.

Taxonomia canônica:

| `trigger` | `mode` permitido | uso |
|---|---|---|
| `INITIAL` | `FULL` | primeira carga |
| `WEBHOOK` | `TARGETED` | IDs, link V2 ou tombstones de um envelope |
| `SCHEDULED` | `INCREMENTAL` ou `FULL` | fallback diário ou reconciliação semanal |
| `ON_DEMAND` | `FULL` | reconciliação operacional solicitada |

Ao persistir `resume_next_query`, a mesma transação grava `resume_run_id`; em `FULL`, também grava `reconciliation_epoch`. Reinício normal com cursor ainda válido adota o epoch existente e continua marcando `transactions.last_reconciliation_epoch` com ele. Somente a conclusão do epoch autoriza detectar ausências. Cursor inválido em `INCREMENTAL` reinicia do watermark com overlap. Cursor inválido em `FULL` aborta o epoch incompleto e, na mesma transação que limpa o cursor, cria **novo** epoch antes de voltar à primeira página sem filtro; marcações do epoch abortado permanecem inertes e nunca participam da comparação final.

`source_key` segue nomes determinísticos:

- `item:<ITEM_ID>`;
- `accounts:<ITEM_ID>`;
- `categories:global`;
- `transactions:<ACCOUNT_ID>`;
- `bills:<ACCOUNT_ID>`;
- `investments:<ITEM_ID>`;
- `loans:<ITEM_ID>`.

`balance_snapshots` mantém no máximo uma linha por conta e dia civil de `America/Sao_Paulo`. Releituras do mesmo dia atualizam a fotografia; dias anteriores nunca são reescritos por uma fatura que mudou depois.

Na linha da conta `CREDIT`, `open_bill_*` copia a obrigação aberta observada naquele dia: valor, vencimento, moeda, fonte e qualidade. `BILLS` significa fatura aberta escolhida pela resposta de `/bills`; `TRANSACTIONS_FALLBACK` significa composição local provisória e exige `PARTIAL`; `UNAVAILABLE` mantém valor/data nulos e qualidade `UNAVAILABLE`. Linhas `BANK` usam `UNAVAILABLE`. A série histórica de patrimônio subtrai esses valores copiados e **não** faz join com a linha mutável de `credit_card_bills` para reconstruir o passado.

### Webhook inbox

`webhook_inbox.event_id` implementa idempotência de recepção. `payload_json` contém apenas o envelope sanitizado necessário para processamento, nunca headers HTTP ou Bearer. Envelope malformado, evento não permitido, tipo/tamanho inválido ou Bearer inválido recebe `4xx` e **não entra** na inbox.

Envelope válido usa `INSERT ... ON CONFLICT(event_id) DO UPDATE ... WHERE webhook_inbox.status = 'FAILED'`: a reentrega antecipa `next_attempt_at` e volta a `RECEIVED`, preservando `attempts` e o primeiro envelope. Linhas `RECEIVED`, `PROCESSING`, `SUCCEEDED` ou `DEAD` não são reabertas. `DEAD` é reservado a falha de processamento classificada permanente em envelope válido; jamais representa erro de parsing/validação da requisição. A resposta `202` só sai depois de confirmar a transação durável.

### Recorrências

`recurring_analysis` guarda o resultado determinístico do agrupamento, incluindo `status`, escores de regularidade/estabilidade em basis points, hiato, retomada e `analysis_version`; esses valores não são derivados ad hoc durante a leitura da API. `recurring_occurrences` preserva evidência transação a transação. CNPJ pode existir apenas em `matcher_value` local; qualquer contexto entregue à IA troca essa chave por um identificador opaco.

### IA

`ai_usage` guarda custo, modelo, tokens, versão de prompt e referências de métricas; não guarda prompt completo, transações nem resposta livre. `ai_cache` guarda somente resposta já sanitizada e as métricas citadas. `context_hash` é calculado sobre o contexto agregado sanitizado, não sobre PII removida.

### Principais de serviço e revisão dos dados

`service_principals` é o registry canônico multi-principal de `/api/agent/v1`: uma linha por consumidor, escopos como array JSON validado contra allowlist e somente hashes de tokens aleatórios de alta entropia. O token bruto é exibido uma vez ao provisionar e nunca entra no banco/log.

Rotação preenche `next_token_hash`, `rotation_started_at` e `current_accept_until`; atual e próximo são aceitos apenas durante essa janela. No corte, uma transação promove o próximo a `current_token_hash` e limpa os três campos de rotação. `active = 0`, `revoked_at` ou `expires_at` vencido bloqueia ambos imediatamente.

`transaction_clarifications` planeja uma fase posterior, sem ativá-la no primeiro consumidor Hermes. Ela guarda pergunta local/publicamente opaca, versão exata da transação, até três categorias sugeridas compactas e reason codes na allowlist `MISSING_DESCRIPTION`, `MISSING_MERCHANT`, `MISSING_CATEGORY`, `INSUFFICIENT_SIGNALS`, `CONTEXT_RULE_REVIEW`. `transaction_revision_key` usa a revisão opaca derivada de `transactions.public_id + version_revision`; `transaction_source_updated_at` conserva separadamente o instante fonte e pode ser nulo. `source_context_rule_id` é preenchido somente na revisão da primeira reaplicação. A aplicação valida que os dois JSONs são arrays compactos, sem repetição e somente com códigos/campos permitidos; `json_valid` do banco é defesa adicional, não validação semântica. `similar_matcher_kind/confidence` registram a oferta segura que existia para aquela revisão — matcher tradicional ou `SOURCE_FINGERPRINT_V1` — e `apply_to_similar` registra a escolha; toda regra criada referencia a clarificação. Não guarda canal, destinatário, ID Pluggy, descrição crua nem resposta livre. `public_id` é o único question ID que pode sair na API.

O evento associado é `UNKNOWN_TRANSACTION_NEEDS_CONTEXT`, com chave ativa `UNKNOWN_TRANSACTION_NEEDS_CONTEXT:<TRANSACTION_PUBLIC_ID>:<TRANSACTION_REVISION_KEY>`. Uma nova versão da transação pode criar nova pergunta; reprocessar a mesma versão não duplica. O evento genérico nunca leva valor exato. Em fase explicitamente aprovada, o principal privado usa `clarifications:read_private` para obter somente data/valor/moeda da transação ainda vigente; outro escopo `clarifications:write` resolve por botão/categoria e, opcionalmente, alias normalizado. Uma categoria escolhida atualiza `local_category_id`; se `apply_to_similar = 1`, cria `category_overrides` quando a oferta for CNPJ/descrição ou `transaction_context_rules` quando for `SOURCE_FINGERPRINT_V1/HIGH`. Alias segue a mesma divisão. Sem matcher oferecido, ambos ficam limitados à transação. Idempotência guarda somente hash da chave e do request normalizado, permitindo repetir a mesma decisão e rejeitar reuso divergente. A resposta bruta opcional é sanitizada e descartada; só a decisão normalizada e sua auditoria permanecem.

Isso é uma exceção futura e estreita ao “zero input”, exclusivamente na superfície de agente/Hermes privado. O site humano continua sem formulário de lançamento ou clarificação, e a primeira fase Hermes permanece estritamente read-only.

`system_state.data_revision` é o contador monotônico canônico dos ETags. Toda transação SQLite que altera dado normalizado, derivado, override ou estado operacional exposto pela API incrementa-o exatamente uma vez no mesmo commit. ETag agrega `metricVersion`, filtros normalizados e `data_revision`; timestamps máximos não são relógio lógico confiável.

### Outbox para Hermes

`outbox_events` é independente de canal: não há coluna Discord, WhatsApp ou destinatário. O payload é JSON compacto, agregado, versionado e sanitizado; nunca contém CNPJ, descrição crua, nome de merchant ou identificadores Pluggy completos. O backend calcula `dedup_key` a partir de tipo + entidade opaca + limiar/ciclo, por exemplo `CREDIT_LIMIT_BAND_CHANGED:<ACCOUNT_KEY>:<BILL_CYCLE>:CRITICAL`. Os CHECKs tornam estados impossíveis inválidos: lease exige dono/prazo/hash; terminal exige principal, `delivery_id` e hash do ack normalizado; campos de entrega não sobrevivem em estado não terminal.

A unicidade vale somente enquanto `condition_closed_at IS NULL`. Nova detecção da mesma condição ativa atualiza `last_occurred_at`/`occurrence_count` na mesma linha; entrega não fecha a condição. Quando o detector prova resolução, preenche `condition_closed_at`; uma recorrência futura pode então criar novo `id` com a mesma `dedup_key`. Transição de faixa ou novo ciclo já produz chave diferente.

O Hermes futuramente obtém lease por `LEASED` e recebe um token aleatório devolvido uma única vez; o banco guarda apenas `lease_token_hash`. Na primeira transição terminal, ack exige token ainda válido e grava `delivery_id`, principal e `ack_request_hash`. Depois do commit, replay pelo mesmo evento + principal + `delivery_id` + request normalizado retorna a resposta terminal anterior mesmo que o lease tenha expirado; combinação divergente falha. Outcome `DELIVERED` preenche `delivered_at`; `DISMISSED` exige `dismissed_at` e uma razão fechada: `POLICY_SUPPRESSED`, `NO_AUTHORIZED_CHANNEL` ou `SUPERSEDED_BY_NEWER_EVENT`. Lease vencido ainda não terminal volta a `PENDING`; tentativas esgotadas vão a `DEAD_LETTER`. A primeira integração é de leitura financeira; nenhum evento autoriza alteração financeira.

## 6. Índices obrigatórios

```sql
CREATE INDEX idx_accounts_item_active
  ON accounts(item_id, deleted_at);

CREATE INDEX idx_transactions_account_date
  ON transactions(account_id, transaction_date DESC, transaction_order DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_transactions_source_created
  ON transactions(account_id, source_created_at);

CREATE INDEX idx_transactions_source_updated
  ON transactions(account_id, source_updated_at);

CREATE INDEX idx_transactions_category_date
  ON transactions(category_id, transaction_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_transactions_local_category_date
  ON transactions(local_category_id, transaction_date DESC)
  WHERE deleted_at IS NULL AND local_category_id IS NOT NULL;

CREATE INDEX idx_transactions_status
  ON transactions(status, transaction_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_transactions_merchant_cnpj
  ON transactions(merchant_cnpj, transaction_date DESC)
  WHERE deleted_at IS NULL AND merchant_cnpj IS NOT NULL;

CREATE INDEX idx_transactions_description_normalized
  ON transactions(description_raw_normalized, transaction_date DESC)
  WHERE deleted_at IS NULL AND description_raw_normalized IS NOT NULL;

CREATE INDEX idx_transaction_tombstones_active
  ON transaction_tombstones(account_id, deleted_at)
  WHERE cleared_at IS NULL;

CREATE INDEX idx_bills_account_due
  ON credit_card_bills(account_id, due_date DESC);

CREATE INDEX idx_balance_snapshots_account_date
  ON balance_snapshots(account_id, snapshot_date DESC);

CREATE INDEX idx_sync_runs_status_started
  ON sync_runs(status, started_at DESC);

CREATE INDEX idx_webhook_inbox_work
  ON webhook_inbox(status, next_attempt_at, received_at)
  WHERE status IN ('RECEIVED','FAILED');

CREATE INDEX idx_recurring_active_next
  ON recurring_analysis(active, next_expected_date);

CREATE INDEX idx_ai_cache_expiry
  ON ai_cache(expires_at);

CREATE INDEX idx_service_principals_active
  ON service_principals(active, expires_at)
  WHERE active = 1 AND revoked_at IS NULL;

CREATE INDEX idx_transaction_clarifications_pending
  ON transaction_clarifications(status, expires_at, created_at)
  WHERE status = 'PENDING';

CREATE INDEX idx_transaction_alias_rules_active
  ON transaction_alias_rules(matcher_type, matcher_value)
  WHERE active = 1;

CREATE INDEX idx_transaction_context_rules_active
  ON transaction_context_rules(account_id, fingerprint_version, fingerprint_hash, direction, currency_code, amount_center_minor)
  WHERE active = 1;

CREATE INDEX idx_transaction_context_rule_applications_rule
  ON transaction_context_rule_applications(context_rule_id, applied_at DESC);

CREATE UNIQUE INDEX uq_outbox_active_dedup
  ON outbox_events(dedup_key)
  WHERE condition_closed_at IS NULL;

CREATE INDEX idx_outbox_delivery
  ON outbox_events(status, available_at, severity)
  WHERE status = 'PENDING';
```

Os índices com CNPJ/descrição permanecem exclusivamente no arquivo SQLite protegido. Nenhum índice ou dump é publicado.

## 7. Upsert e atomicidade

Upsert de transação, abreviado para destacar a regra:

```sql
INSERT INTO transactions (
  id, public_id, account_id, amount_minor, status, category_id,
  raw_json_sanitized, first_seen_at, last_seen_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  account_id         = excluded.account_id,
  amount_minor       = excluded.amount_minor,
  status             = excluded.status,
  category_id        = excluded.category_id,
  raw_json_sanitized = excluded.raw_json_sanitized,
  last_seen_at       = excluded.last_seen_at,
  updated_at         = excluded.updated_at;
```

A migration real lista **todas** as colunas mutáveis no `DO UPDATE`; o trecho é ilustrativo. O segundo bind é um novo ULID somente para a tentativa de insert: conflito em `id` não altera `public_id`. A releitura também nunca sobrescreve `first_seen_at`, `local_category_id` nem `transaction_overrides`.

Esse upsert só recebe resultados de uma leitura atual da Pluggy. Antes dele, a transação verifica tombstone ativo. Se o ID foi devolvido pela leitura autoritativa, o mesmo commit registra a limpeza auditável do tombstone; um envelope/evento isolado nunca chama o upsert nem limpa `deleted_at`.

Cada página segue esta fronteira:

1. baixar e validar fora da transação SQLite;
2. sanitizar todos os registros;
3. `BEGIN IMMEDIATE`;
4. upsert dos registros e contadores do run;
5. persistir `resume_next_query`, `resume_run_id` e, no modo `FULL`, `reconciliation_epoch`;
6. `COMMIT`.

Na última página, o mesmo commit limpa `resume_next_query`/`resume_run_id`; no incremental, avança `created_at_watermark`; no full, só conclui `reconciliation_epoch` depois de aplicar a comparação de ausências. Se o processo cair, a página inteira existe ou não existe; repeti-la é segura.

## 8. Consultas e dados derivados

Toda consulta normal de movimentação contém `transactions.deleted_at IS NULL`. “Gasto do mês” também exige:

- tipo/sinal coerente com despesa da modalidade da conta;
- status conforme o widget (`POSTED` para realizado; `PENDING` somente em projeções claramente rotuladas);
- transferência interna efetiva igual a 0;
- ausência em `transaction_bill_payment_matches`, em qualquer role;
- valores convertidos por moeda ou, nesta fase, `currency_code = 'BRL'`.

Crédito de cartão ativo e não pareado não reduz automaticamente o gasto: é ajuste não classificado e degrada a qualidade do período para `partial`. Métricas financeiras são calculadas no backend sobre inteiros em unidade mínima. Divisão e percentuais usam decimal explícito e regra de arredondamento documentada no endpoint. A IA nunca refaz essas contas.

## 9. Integridade e testes de migration

Gates mínimos da implementação:

- abrir banco vazio, aplicar todas as migrations e executar `PRAGMA foreign_key_check` sem linhas;
- aplicar migrations novamente sem alteração inesperada;
- compilar este schema em SQLite suportado e executar `PRAGMA foreign_key_check` após fixtures relacionais;
- provar que upsert por ID externo conserva o mesmo `public_id` e que somente `public_id` aparece nos DTOs;
- simular `PENDING → POSTED` no mesmo ID e provar uma única linha com valor novo;
- simular delete conhecido e desconhecido; provar que evento atrasado não ressuscita e que somente GET atual autoritativo limpa o tombstone;
- inserir canários em payer/receiver `documentNumber` e nas chaves `owner`, `taxNumber`, `number`, `cardNumber`, `identificationNumber` e `identity`; provar remoção fail-closed antes do SQLite, logs, cache e erros;
- parear pagamento de fatura em cada role, provar exclusão do gasto e provar que empate ou crédito de cartão sem match retorna qualidade parcial;
- mudar uma fatura depois do fechamento do dia e provar que o `open_bill_amount_minor` do snapshot histórico anterior não muda;
- interromper full sync entre páginas e provar retomada normal no mesmo epoch; invalidar cursor full, criar novo epoch e provar que uma linha marcada apenas no epoch abortado pode ser tombstonada se não reaparecer desde a página 1; no incremental, provar retorno ao watermark-overlap;
- provar unicidade parcial da outbox, encerramento/reabertura de condição e validação do `lease_token_hash`;
- rotacionar dois principais de serviço de forma independente e provar o corte current/next;
- criar duas vezes a clarificação da mesma versão e obter uma pergunta; provar que o evento só expõe `public_id`, que valor exato exige `clarifications:read_private` + resposta `no-store` e que `clarifications:write` não substitui esse escopo;
- provar que `apply_to_similar = true` só cria regra do `similar_matcher_kind/HIGH` oferecido; para `SOURCE_FINGERPRINT_V1`, conta/direção/moeda/valor divergentes não casam e fingerprint nunca sai do SQLite;
- aplicar uma context rule pela primeira vez, provar application + evento de revisão únicos e, numa correção por nova clarificação vigente, desativar a regra e atualizar `correction_count`/auditoria atomicamente; silêncio não altera classificação;
- provar que um commit de dados visível incrementa `system_state.data_revision` uma vez e que rollback não incrementa;
- reabrir o banco e validar `journal_mode=wal`, `foreign_keys=1` em cada conexão;
- verificar plano de consulta dos widgets principais com `EXPLAIN QUERY PLAN` usando os índices previstos;
- executar backup consistente, abrir a cópia e rodar `PRAGMA integrity_check` com resultado `ok`.

## Pendências / a confirmar

- Aprovar em gate próprio a fase de clarificação Hermes, sua allowlist e o par de escopos `clarifications:read_private`/`clarifications:write` antes de criar qualquer principal; a primeira integração continua read-only.
- Fechar o mapeamento coluna a coluna de `/loans` quando existir uma resposta real; hoje o produto retorna vazio.
- Confirmar se `financeCharges[].id` e `payments[].id` são sempre estáveis no conector usado; se algum vier nulo, definir chave determinística de fallback antes da migration.
- Definir na rodada de implementação a duração do cache de IA por caso de uso, sem mudar o contrato de sanitização.
- Validar em teste de carga local se `busy_timeout=5000` é suficiente com worker de webhook e job agendado concorrentes.
