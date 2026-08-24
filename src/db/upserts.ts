/**
 * Upserts — docs/05 §transações e docs/04 §5-6.
 *
 * Conflito pelo ID externo preserva o public_id local já existente;
 * campos mutáveis (status, valor, saldo) são atualizados no upsert
 * porque transações PENDING viram POSTED (docs/04 §6).
 */
import type { Db } from '../db/index.ts';
import { ulid } from 'ulid';

export interface UpsertAccountInput {
  externalId: string;
  itemPublicId: string;
  type: string;
  subtype: string | null;
  label: string;
  balance: number | null;
  currency: string | null;
  /** Saldo de fechamento do dia bancário, quando a fonte informa. */
  closingBalance?: number | null;
  /** Metadados de crédito — nunca número do cartão (docs/09 §5.2). */
  credit?: {
    level: string | null;
    brand: string | null;
    creditLimit: number | null;
    availableCreditLimit: number | null;
    balanceDueDate: string | null;
    balanceCloseDate: string | null;
    minimumPayment: number | null;
    status: string | null;
  } | null;
}

export function upsertAccount(db: Db, input: UpsertAccountInput): string {
  const row = db
    .prepare('SELECT public_id FROM accounts WHERE external_id = ?')
    .get(input.externalId) as { public_id: string } | undefined;
  const credit = input.credit ?? null;
  const publicId = row?.public_id ?? ulid();

  if (row) {
    db.prepare(
      `UPDATE accounts SET type=?, subtype=?, label=?, balance=?, currency=?, closing_balance=?,
         credit_limit=?, available_credit_limit=?, credit_level=?, credit_brand=?,
         balance_due_date=?, balance_close_date=?, minimum_payment=?, credit_status=?,
         synced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE public_id=?`
    ).run(
      input.type, input.subtype, input.label, input.balance, input.currency ?? 'BRL',
      input.closingBalance ?? null,
      credit?.creditLimit ?? null, credit?.availableCreditLimit ?? null,
      credit?.level ?? null, credit?.brand ?? null,
      credit?.balanceDueDate ?? null, credit?.balanceCloseDate ?? null,
      credit?.minimumPayment ?? null, credit?.status ?? null,
      publicId
    );
    return publicId;
  }

  db.prepare(
    `INSERT INTO accounts (public_id, external_id, item_public_id, type, subtype, label, balance,
       currency, closing_balance, credit_limit, available_credit_limit, credit_level, credit_brand,
       balance_due_date, balance_close_date, minimum_payment, credit_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    publicId, input.externalId, input.itemPublicId, input.type, input.subtype, input.label,
    input.balance, input.currency ?? 'BRL', input.closingBalance ?? null,
    credit?.creditLimit ?? null, credit?.availableCreditLimit ?? null,
    credit?.level ?? null, credit?.brand ?? null,
    credit?.balanceDueDate ?? null, credit?.balanceCloseDate ?? null,
    credit?.minimumPayment ?? null, credit?.status ?? null
  );
  return publicId;
}

export interface CreditLimitLine {
  creditLineLimitType: string | null;
  consolidationType: string | null;
  isLimitFlexible: boolean | null;
  usedAmount: number | null;
  limitAmount: number | null;
  availableAmount: number | null;
  customizedLimitAmount: number | null;
  currencyCode: string | null;
}

/** Limites desagregados: espelho por ordinal, nunca somados ao total. */
export function replaceCreditLimits(
  db: Db,
  accountPublicId: string,
  lines: readonly CreditLimitLine[]
): void {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM account_credit_limits WHERE account_public_id = ?').run(accountPublicId);
    lines.forEach((line, ordinal) => {
      db.prepare(
        `INSERT INTO account_credit_limits (account_public_id, ordinal, credit_line_limit_type,
           consolidation_type, is_limit_flexible, used_amount_minor, limit_amount_minor,
           available_amount_minor, customized_limit_amount_minor, currency_code, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).run(
        accountPublicId,
        ordinal,
        line.creditLineLimitType,
        line.consolidationType,
        line.isLimitFlexible === null ? null : line.isLimitFlexible ? 1 : 0,
        toMinorOrNull(line.usedAmount),
        toMinorOrNull(line.limitAmount),
        toMinorOrNull(line.availableAmount),
        toMinorOrNull(line.customizedLimitAmount),
        line.currencyCode
      );
    });
  });
  run();
}

function toMinorOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100);
}

export interface UpsertTransactionInput {
  externalId: string;
  accountPublicId: string;
  amount: number;
  currency: string;
  date: string;
  status: 'POSTED' | 'PENDING';
  type: 'DEBIT' | 'CREDIT' | null;
  operationType: string | null;
  description: string | null;
  categoryId: string | null;
  balanceAfter: number | null;
  orderTiebreak: number | null;
  rawJsonSanitized: string;
  /** `creditCardMetadata.billForecastDate` — no tenant medido vem `YYYY-MM`. */
  billForecastDate?: string | null;
  merchantCnpj?: string | null;
  merchantBusinessName?: string | null;
  descriptionRawNormalized?: string | null;
  payeeMcc?: number | null;
}

export function upsertTransaction(db: Db, input: UpsertTransactionInput): { publicId: string; inserted: boolean } {
  const existing = db
    .prepare('SELECT public_id FROM transactions WHERE external_id = ?')
    .get(input.externalId) as { public_id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE transactions SET amount=?, date=?, status=?, type=?, operation_type=?,
       description=?, balance_after=?, order_tiebreak=?, raw_json_sanitized=?,
       bill_forecast_date=?, merchant_cnpj=?, merchant_business_name=?,
       description_raw_normalized=?, payee_mcc=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE public_id=? AND category_override=0`
    ).run(
      input.amount, input.date, input.status, input.type, input.operationType,
      input.description, input.balanceAfter, input.orderTiebreak, input.rawJsonSanitized,
      input.billForecastDate ?? null, input.merchantCnpj ?? null,
      input.merchantBusinessName ?? null, input.descriptionRawNormalized ?? null,
      input.payeeMcc ?? null,
      existing.public_id
    );
    return { publicId: existing.public_id, inserted: false };
  }

  const publicId = ulid();
  db.prepare(
    `INSERT INTO transactions
     (public_id, external_id, account_public_id, amount, currency, date, status, type,
      operation_type, description, category_id, balance_after, order_tiebreak, raw_json_sanitized,
      bill_forecast_date, merchant_cnpj, merchant_business_name, description_raw_normalized, payee_mcc)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    publicId, input.externalId, input.accountPublicId, input.amount, input.currency,
    input.date, input.status, input.type, input.operationType, input.description,
    input.categoryId, input.balanceAfter, input.orderTiebreak, input.rawJsonSanitized,
    input.billForecastDate ?? null, input.merchantCnpj ?? null,
    input.merchantBusinessName ?? null, input.descriptionRawNormalized ?? null,
    input.payeeMcc ?? null
  );
  return { publicId, inserted: true };
}
