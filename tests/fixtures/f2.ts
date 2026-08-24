/**
 * Fixtures da F2 — dados sintéticos, nenhum valor real e nenhum ID da
 * Pluggy. Datas são civis de São Paulo, salvo quando o teste quer provar a
 * conversão de instante UTC para dia local.
 */
import { openDb, type Db } from '../../src/db/index.js';
import { ulid } from 'ulid';

export const BANK = 'acc-bank';
export const CARD = 'acc-card';

export const CAT_COMPRAS = '08000000';
export const CAT_VESTUARIO = '08040000';
export const CAT_ALIMENTACAO = '11000000';
export const CAT_TRANSFER = '04000000';

export function makeDb(path = ':memory:'): Db {
  const db = openDb(path);
  db.prepare('INSERT INTO items (public_id, external_id, status) VALUES (?,?,?)').run(
    'item-1',
    'ext-item-1',
    'UPDATED'
  );
  insertAccount(db, BANK, 'BANK', 'Conta corrente', 1000);
  insertAccount(db, CARD, 'CREDIT', 'Cartão', -200);
  for (const [id, label] of [
    [CAT_COMPRAS, 'Compras'],
    [CAT_VESTUARIO, 'Vestuário'],
    [CAT_ALIMENTACAO, 'Alimentação'],
    [CAT_TRANSFER, 'Transferência mesma titularidade'],
  ] as const) {
    db.prepare(
      `INSERT INTO categories (id, description, description_translated, level1_prefix)
       VALUES (?,?,?,?)`
    ).run(id, label, label, id.slice(0, 2));
  }
  return db;
}

export function insertAccount(
  db: Db,
  publicId: string,
  type: 'BANK' | 'CREDIT',
  label: string,
  balance: number,
  currency = 'BRL'
): void {
  db.prepare(
    `INSERT INTO accounts (public_id, external_id, item_public_id, type, subtype, label, balance, currency)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(publicId, `ext-${publicId}`, 'item-1', type, null, label, balance, currency);
}

export interface TxInput {
  id?: string;
  account?: string;
  date: string;
  amount: number;
  type?: 'DEBIT' | 'CREDIT';
  status?: 'POSTED' | 'PENDING';
  categoryId?: string | null;
  internalTransfer?: boolean;
  currency?: string;
  order?: number;
}

export function addTx(db: Db, input: TxInput): string {
  const publicId = input.id ?? ulid();
  db.prepare(
    `INSERT INTO transactions
       (public_id, external_id, account_public_id, amount, currency, date, status, type,
        category_id, is_internal_transfer, order_tiebreak, raw_json_sanitized)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    publicId,
    `ext-${publicId}`,
    input.account ?? BANK,
    Math.abs(input.amount),
    input.currency ?? 'BRL',
    input.date,
    input.status ?? 'POSTED',
    input.type ?? 'DEBIT',
    input.categoryId === undefined ? CAT_COMPRAS : input.categoryId,
    input.internalTransfer ? 1 : 0,
    input.order ?? null,
    '{}'
  );
  return publicId;
}

/** Pareia os dois lados de um pagamento de fatura (docs/09 §2.2). */
export function addBillPaymentMatch(
  db: Db,
  params: { bankTxId: string; cardTxId?: string; amountMinor: number; dueDate: string }
): void {
  const billId = ulid();
  const paymentId = ulid();
  db.prepare(
    `INSERT INTO credit_card_bills (public_id, external_id, account_public_id, due_date,
       total_amount_minor, currency_code, updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'))`
  ).run(billId, `ext-${billId}`, CARD, params.dueDate, params.amountMinor, 'BRL');
  db.prepare(
    `INSERT INTO bill_payments (public_id, external_id, bill_public_id, payment_date, amount_minor,
       currency_code, updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'))`
  ).run(paymentId, `ext-${paymentId}`, billId, params.dueDate, params.amountMinor, 'BRL');

  const link = (txId: string, role: 'BANK_DEBIT' | 'CARD_CREDIT') =>
    db
      .prepare(
        `INSERT INTO transaction_bill_payment_matches
           (id, bill_payment_public_id, transaction_public_id, role, confidence, evidence_json,
            algorithm_version, matched_at)
         VALUES (?,?,?,?,?,?,?,datetime('now'))`
      )
      .run(ulid(), paymentId, txId, role, 'HIGH', '{"fixture":true}', 'MATCH_V1');

  link(params.bankTxId, 'BANK_DEBIT');
  if (params.cardTxId) link(params.cardTxId, 'CARD_CREDIT');
}

export interface SnapshotInput {
  date: string;
  bankMinor?: number | null;
  billMinor?: number | null;
  billDueDate?: string | null;
  source?: 'BILLS' | 'TRANSACTIONS_FALLBACK' | 'UNAVAILABLE';
  quality?: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
}

export function addSnapshot(db: Db, input: SnapshotInput): void {
  const insert = db.prepare(
    `INSERT INTO balance_snapshots
       (id, account_public_id, sync_run_id, snapshot_date, captured_at, balance_minor,
        closing_balance_minor, open_bill_amount_minor, open_bill_due_date,
        open_bill_currency_code, open_bill_source, open_bill_quality, currency_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  if (input.bankMinor !== undefined) {
    insert.run(
      ulid(), BANK, null, input.date, `${input.date}T12:00:00.000Z`,
      input.bankMinor, input.bankMinor, null, null, null, 'UNAVAILABLE', 'UNAVAILABLE', 'BRL'
    );
  }
  if (input.billMinor !== undefined) {
    insert.run(
      ulid(), CARD, null, input.date, `${input.date}T12:00:00.000Z`,
      input.billMinor === null ? null : -input.billMinor,
      input.billMinor === null ? null : -input.billMinor,
      input.billMinor,
      input.billDueDate ?? null,
      'BRL',
      input.source ?? 'BILLS',
      input.quality ?? 'COMPLETE',
      'BRL'
    );
  }
}

/** Harvest bem-sucedido que dá cobertura aos dias anteriores. */
export function addSyncRun(db: Db, finishedAt: string, ok = true): void {
  db.prepare(
    `INSERT INTO sync_runs (id, started_at, finished_at, kind, ok) VALUES (?,?,?,?,?)`
  ).run(ulid(), finishedAt, finishedAt, 'daily', ok ? 1 : 0);
}

/** Gasto confirmado repetido em vários meses, sempre no mesmo dia do mês. */
export function seedMonthlySpend(
  db: Db,
  months: readonly string[],
  day: number,
  amount: number,
  categoryId: string = CAT_COMPRAS
): void {
  for (const month of months) {
    addTx(db, {
      date: `${month}-${String(day).padStart(2, '0')}`,
      amount,
      categoryId,
    });
  }
}
