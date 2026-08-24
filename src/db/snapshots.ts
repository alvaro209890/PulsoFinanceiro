/**
 * Snapshots diários de saldo — docs/06 §279 e docs/09 §4.1.
 *
 * A fotografia do dia COPIA a obrigação aberta do cartão (`open_bill_*`)
 * com valor, vencimento, moeda, fonte e qualidade. Job posterior nunca
 * reescreve dia anterior: a série histórica não pode depender da linha
 * mutável da fatura de hoje. Não se fabrica histórico retrocedendo
 * transações — antes do primeiro snapshot existe lacuna, não série.
 */
import type { Db } from './index.js';
import { ulid } from 'ulid';
import { addDays, DEFAULT_TIMEZONE, today as todayCivil } from '../finance/time.js';
import { toMinor } from '../finance/ledger.js';

export type OpenBillSource = 'BILLS' | 'TRANSACTIONS_FALLBACK' | 'UNAVAILABLE';
export type OpenBillQuality = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';

export interface SnapshotResult {
  snapshotDate: string;
  accounts: number;
}

interface AccountRow {
  public_id: string;
  type: string;
  balance: number | null;
  closing_balance: number | null;
  currency: string;
}

/**
 * Grava (ou atualiza) o snapshot do DIA CORRENTE para cada conta.
 * Idempotente por (conta, dia): rodar o harvest duas vezes no mesmo dia
 * não cria linha nova nem altera dias anteriores.
 */
export function captureDailySnapshots(
  db: Db,
  options: { syncRunId?: string | null; now?: Date; timezone?: string } = {}
): SnapshotResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? new Date();
  const snapshotDate = todayCivil(timezone, now);
  const capturedAt = now.toISOString();

  const accounts = db
    .prepare('SELECT public_id, type, balance, closing_balance, currency FROM accounts')
    .all() as AccountRow[];

  const stmt = db.prepare(
    `INSERT INTO balance_snapshots
       (id, account_public_id, sync_run_id, snapshot_date, captured_at, balance_minor,
        closing_balance_minor, open_bill_amount_minor, open_bill_due_date,
        open_bill_currency_code, open_bill_source, open_bill_quality, currency_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_public_id, snapshot_date) DO UPDATE SET
       sync_run_id = excluded.sync_run_id,
       captured_at = excluded.captured_at,
       balance_minor = excluded.balance_minor,
       closing_balance_minor = excluded.closing_balance_minor,
       open_bill_amount_minor = excluded.open_bill_amount_minor,
       open_bill_due_date = excluded.open_bill_due_date,
       open_bill_currency_code = excluded.open_bill_currency_code,
       open_bill_source = excluded.open_bill_source,
       open_bill_quality = excluded.open_bill_quality,
       currency_code = excluded.currency_code`
  );

  const run = db.transaction(() => {
    for (const account of accounts) {
      const balanceMinor = account.balance === null ? null : signedMinor(account.balance);
      const closingMinor =
        account.closing_balance === null ? balanceMinor : signedMinor(account.closing_balance);
      const bill = account.type === 'CREDIT' ? openBillFor(db, account, snapshotDate) : NO_BILL;
      stmt.run(
        ulid(),
        account.public_id,
        options.syncRunId ?? null,
        snapshotDate,
        capturedAt,
        balanceMinor,
        closingMinor,
        bill.amountMinor,
        bill.dueDate,
        bill.currencyCode,
        bill.source,
        bill.quality,
        account.currency
      );
    }
  });
  run();

  return { snapshotDate, accounts: accounts.length };
}

interface OpenBill {
  amountMinor: number | null;
  dueDate: string | null;
  currencyCode: string | null;
  source: OpenBillSource;
  quality: OpenBillQuality;
}

const NO_BILL: OpenBill = {
  amountMinor: null,
  dueDate: null,
  currencyCode: null,
  source: 'UNAVAILABLE',
  quality: 'UNAVAILABLE',
};

/**
 * Obrigação aberta do cartão no instante da fotografia:
 * `/bills` quando existe fatura em aberto (COMPLETE); soma das saídas
 * confirmadas do ciclo quando não existe (PARTIAL); ausência é UNAVAILABLE
 * — nunca zero.
 */
function openBillFor(db: Db, account: AccountRow, snapshotDate: string): OpenBill {
  const bill = db
    .prepare(
      `SELECT total_amount_minor, due_date, currency_code, bill_closing_date
         FROM credit_card_bills
        WHERE account_public_id = ? AND due_date >= ?
        ORDER BY due_date ASC LIMIT 1`
    )
    .get(account.public_id, snapshotDate) as
    | { total_amount_minor: number; due_date: string; currency_code: string; bill_closing_date: string | null }
    | undefined;

  if (bill) {
    return {
      amountMinor: bill.total_amount_minor,
      dueDate: bill.due_date,
      currencyCode: bill.currency_code,
      source: 'BILLS',
      quality: 'COMPLETE',
    };
  }

  // Fallback declarado: soma das saídas confirmadas dos últimos 30 dias na
  // conta de cartão. É aproximação de ciclo, por isso a qualidade é PARTIAL.
  const cycleStart = addDays(snapshotDate, -30);
  const fallback = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
         FROM transactions
        WHERE account_public_id = ? AND status = 'POSTED' AND type = 'DEBIT'
          AND substr(date,1,10) >= ?`
    )
    .get(account.public_id, cycleStart) as { total: number; n: number };

  if (fallback.n === 0) return NO_BILL;

  return {
    amountMinor: toMinor(fallback.total),
    dueDate: null,
    currencyCode: account.currency,
    source: 'TRANSACTIONS_FALLBACK',
    quality: 'PARTIAL',
  };
}

/** Centavos com sinal preservado (saldo pode ser negativo). */
function signedMinor(amount: number): number {
  return Math.round(amount * 100);
}
