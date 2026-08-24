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
}

export function upsertAccount(db: Db, input: UpsertAccountInput): string {
  const row = db
    .prepare('SELECT public_id FROM accounts WHERE external_id = ?')
    .get(input.externalId) as { public_id: string } | undefined;
  if (row) {
    db.prepare(
      `UPDATE accounts SET type=?, subtype=?, label=?, balance=?, currency=?,
       synced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_id=?`
    ).run(input.type, input.subtype, input.label, input.balance, input.currency ?? 'BRL', row.public_id);
    return row.public_id;
  }
  const publicId = ulid();
  db.prepare(
    `INSERT INTO accounts (public_id, external_id, item_public_id, type, subtype, label, balance, currency)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(publicId, input.externalId, input.itemPublicId, input.type, input.subtype, input.label, input.balance, input.currency ?? 'BRL');
  return publicId;
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
}

export function upsertTransaction(db: Db, input: UpsertTransactionInput): { publicId: string; inserted: boolean } {
  const existing = db
    .prepare('SELECT public_id FROM transactions WHERE external_id = ?')
    .get(input.externalId) as { public_id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE transactions SET amount=?, date=?, status=?, type=?, operation_type=?,
       description=?, balance_after=?, order_tiebreak=?, raw_json_sanitized=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE public_id=? AND category_override=0`
    ).run(
      input.amount, input.date, input.status, input.type, input.operationType,
      input.description, input.balanceAfter, input.orderTiebreak, input.rawJsonSanitized,
      existing.public_id
    );
    return { publicId: existing.public_id, inserted: false };
  }

  const publicId = ulid();
  db.prepare(
    `INSERT INTO transactions
     (public_id, external_id, account_public_id, amount, currency, date, status, type,
      operation_type, description, category_id, balance_after, order_tiebreak, raw_json_sanitized)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    publicId, input.externalId, input.accountPublicId, input.amount, input.currency,
    input.date, input.status, input.type, input.operationType, input.description,
    input.categoryId, input.balanceAfter, input.orderTiebreak, input.rawJsonSanitized
  );
  return { publicId, inserted: true };
}
