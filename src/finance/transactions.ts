/**
 * Evidências — `GET /api/v1/transactions` (docs/07).
 *
 * O drawer de composição abre por aqui: o navegador NÃO recalcula valor,
 * apenas lista as linhas que o backend já classificou. O DTO expõe somente
 * `public_id` local e nunca `raw_json_sanitized`, ID da Pluggy, documento,
 * número de conta ou cartão.
 *
 * Ordenação estável: `date DESC, order DESC, id DESC`; o cursor codifica
 * exatamente essas três chaves e não tem relação com o cursor da Pluggy.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { civilDate, DEFAULT_TIMEZONE } from './time.js';
import { INTERNAL_TRANSFER_ROOT, NO_CATEGORY_ROOT } from './ledger.js';

export const TRANSACTIONS_MAX_LIMIT = 100;
export const TRANSACTIONS_DEFAULT_LIMIT = 50;

export interface TransactionDto {
  id: string;
  version: string;
  description: string | null;
  date: string;
  amount: number;
  currencyCode: string;
  type: string | null;
  status: string;
  category: { id: string | null; label: string | null; rootCode: string };
  effectiveInternalTransfer: boolean;
  billPaymentMatch: { role: string; confidence: string } | null;
  cardCreditClassification: 'UNCLASSIFIED' | null;
  categoryOverride: boolean;
}

export interface ListOptions {
  from: string;
  to: string;
  /**
   * `SPEND` devolve apenas o que a regra consolidada considera gasto
   * elegível — é o filtro que faz a composição do card fechar com o valor
   * do card. A decisão continua no backend: o navegador nunca soma nem
   * descarta linha por conta própria.
   */
  eligibility?: 'SPEND' | 'ALL' | undefined;
  accountId?: string | undefined;
  categoryRoot?: string | undefined;
  status?: 'POSTED' | 'PENDING' | 'ALL' | undefined;
  type?: 'DEBIT' | 'CREDIT' | 'ALL' | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  timezone?: string | undefined;
}

export class CursorInvalid extends Error {}

interface Row {
  public_id: string;
  updated_at: string;
  description: string | null;
  date: string;
  amount: number;
  currency: string;
  type: string | null;
  status: string;
  category_id: string | null;
  category_label: string | null;
  account_type: string;
  is_internal_transfer: number;
  category_override: number;
  order_tiebreak: number | null;
  bill_role: string | null;
  bill_confidence: string | null;
}

export function listTransactions(
  db: Db,
  options: ListOptions
): { data: TransactionDto[]; nextCursor: string | null } {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const limit = Math.min(options.limit ?? TRANSACTIONS_DEFAULT_LIMIT, TRANSACTIONS_MAX_LIMIT);
  const status = options.status ?? 'ALL';
  const type = options.type ?? 'ALL';

  const where: string[] = [
    `date(substr(t.date,1,10)) >= date(?, '-1 day')`,
    `date(substr(t.date,1,10)) <  date(?, '+1 day')`,
  ];
  const args: unknown[] = [options.from, options.to];

  if (options.accountId) {
    where.push('t.account_public_id = ?');
    args.push(options.accountId);
  }
  if (options.categoryRoot) {
    if (options.categoryRoot === NO_CATEGORY_ROOT) where.push('t.category_id IS NULL');
    else {
      where.push('substr(t.category_id,1,2) = ?');
      args.push(options.categoryRoot);
    }
  }
  if (status !== 'ALL') {
    where.push('t.status = ?');
    args.push(status);
  }
  if (type !== 'ALL') {
    where.push('t.type = ?');
    args.push(type);
  }

  const rows = db
    .prepare(
      `SELECT t.public_id, t.updated_at, t.description, t.date, t.amount, t.currency, t.type,
              t.status, t.category_id, c.description_translated AS category_label,
              a.type AS account_type, t.is_internal_transfer, t.category_override,
              t.order_tiebreak, m.role AS bill_role, m.confidence AS bill_confidence
         FROM transactions t
         JOIN accounts a ON a.public_id = t.account_public_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN transaction_bill_payment_matches m ON m.transaction_public_id = t.public_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.date DESC, t.order_tiebreak DESC, t.public_id DESC`
    )
    .all(...args) as Row[];

  const civil = rows
    .map((r) => ({ row: r, date: civilDate(r.date, timezone) }))
    .filter((r) => r.date >= options.from && r.date < options.to)
    .filter((r) => (options.eligibility === 'SPEND' ? isEligibleSpend(r.row) : true));

  let startIndex = 0;
  if (options.cursor) {
    const key = decodeCursor(options.cursor);
    const idx = civil.findIndex(
      (r) => `${r.date}|${r.row.order_tiebreak ?? ''}|${r.row.public_id}` === key
    );
    if (idx < 0) throw new CursorInvalid('CURSOR_SNAPSHOT_EXPIRED');
    startIndex = idx + 1;
  }

  const page = civil.slice(startIndex, startIndex + limit);
  const last = page[page.length - 1];
  const hasMore = startIndex + limit < civil.length;

  return {
    data: page.map(({ row, date }) => toDto(row, date)),
    nextCursor:
      hasMore && last
        ? encodeCursor(`${last.date}|${last.row.order_tiebreak ?? ''}|${last.row.public_id}`)
        : null,
  };
}

/** Mesma exclusão do razão elegível: prefixo 04, flag local e match de fatura. */
function isEligibleSpend(row: Row): boolean {
  const rootCode = row.category_id ? row.category_id.slice(0, 2) : NO_CATEGORY_ROOT;
  const internal = row.is_internal_transfer === 1 || rootCode === INTERNAL_TRANSFER_ROOT;
  return row.type === 'DEBIT' && !internal && row.bill_role === null;
}

function toDto(row: Row, date: string): TransactionDto {
  const rootCode = row.category_id ? row.category_id.slice(0, 2) : NO_CATEGORY_ROOT;
  const billRole = row.bill_role === 'BANK_DEBIT' || row.bill_role === 'CARD_CREDIT' ? row.bill_role : null;
  return {
    id: row.public_id,
    version: transactionVersion(row.public_id, row.updated_at),
    description: row.description,
    date,
    amount: Math.round(Math.abs(row.amount) * 100) / 100,
    currencyCode: row.currency,
    type: row.type,
    status: row.status,
    category: { id: row.category_id, label: row.category_label, rootCode },
    effectiveInternalTransfer: row.is_internal_transfer === 1 || rootCode === INTERNAL_TRANSFER_ROOT,
    billPaymentMatch: billRole ? { role: billRole, confidence: row.bill_confidence ?? 'MEDIUM' } : null,
    cardCreditClassification:
      row.type === 'CREDIT' && row.account_type === 'CREDIT' && billRole === null ? 'UNCLASSIFIED' : null,
    categoryOverride: row.category_override === 1,
  };
}

/** `version` do If-Match: hash do par (public_id, última escrita servida). */
export function transactionVersion(publicId: string, updatedAt: string): string {
  return createHash('sha256').update(`${publicId}\0${updatedAt}`).digest('base64url');
}

function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded.includes('|')) throw new CursorInvalid('CURSOR_MALFORMED');
    return decoded;
  } catch {
    throw new CursorInvalid('CURSOR_MALFORMED');
  }
}
