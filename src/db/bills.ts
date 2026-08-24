/**
 * Persistência de faturas — docs/05 §`credit_card_bills`, encargos e
 * pagamentos.
 *
 * A fatura é atualizada por `bill.id` externo e preserva o `public_id`
 * local. Em uma releitura completa, os filhos ausentes na nova resposta são
 * removidos DENTRO da transação do próprio pai: a fatura continua registro
 * auditável, os encargos e pagamentos são espelho do que a fonte devolve.
 */
import type { Db } from './index.js';
import { ulid } from 'ulid';
import type { PluggyBill } from '../pluggy/client.js';
import { toMinor } from '../finance/ledger.js';

export interface UpsertBillsResult {
  bills: number;
  financeCharges: number;
  payments: number;
}

/** Data civil `YYYY-MM-DD` a partir do que a Pluggy devolve. */
export function billDate(value: string | null): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

export function upsertBills(db: Db, accountPublicId: string, bills: readonly PluggyBill[]): UpsertBillsResult {
  const result: UpsertBillsResult = { bills: 0, financeCharges: 0, payments: 0 };

  const run = db.transaction(() => {
    for (const bill of bills) {
      const dueDate = billDate(bill.dueDate);
      if (!dueDate) continue; // fatura sem vencimento não é registro utilizável

      const existing = db
        .prepare('SELECT public_id FROM credit_card_bills WHERE external_id = ?')
        .get(bill.id) as { public_id: string } | undefined;
      const publicId = existing?.public_id ?? ulid();
      const currency = bill.totalAmountCurrencyCode ?? 'BRL';

      if (existing) {
        db.prepare(
          `UPDATE credit_card_bills SET account_public_id=?, due_date=?, bill_closing_date=?,
             total_amount_minor=?, currency_code=?, minimum_payment_amount_minor=?,
             allows_installments=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE public_id=?`
        ).run(
          accountPublicId,
          dueDate,
          billDate(bill.billClosingDate),
          toMinor(bill.totalAmount),
          currency,
          bill.minimumPaymentAmount === null ? null : toMinor(bill.minimumPaymentAmount),
          bill.allowsInstallments === null ? null : bill.allowsInstallments ? 1 : 0,
          publicId
        );
      } else {
        db.prepare(
          `INSERT INTO credit_card_bills (public_id, external_id, account_public_id, due_date,
             bill_closing_date, total_amount_minor, currency_code, minimum_payment_amount_minor,
             allows_installments, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).run(
          publicId,
          bill.id,
          accountPublicId,
          dueDate,
          billDate(bill.billClosingDate),
          toMinor(bill.totalAmount),
          currency,
          bill.minimumPaymentAmount === null ? null : toMinor(bill.minimumPaymentAmount),
          bill.allowsInstallments === null ? null : bill.allowsInstallments ? 1 : 0
        );
      }
      result.bills += 1;

      // Filhos são espelho: apaga e reinsere na mesma transação do pai.
      db.prepare('DELETE FROM bill_finance_charges WHERE bill_public_id = ?').run(publicId);
      for (const charge of bill.financeCharges) {
        db.prepare(
          `INSERT INTO bill_finance_charges (id, bill_public_id, external_id, type, amount_minor,
             currency_code, additional_info, updated_at)
           VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).run(
          ulid(),
          publicId,
          charge.id,
          charge.type,
          toMinor(charge.amount),
          charge.currencyCode ?? currency,
          charge.additionalInfo
        );
        result.financeCharges += 1;
      }

      // Pagamentos preservam o public_id de quem já tem match derivado.
      const previous = db
        .prepare('SELECT public_id, external_id FROM bill_payments WHERE bill_public_id = ?')
        .all(publicId) as Array<{ public_id: string; external_id: string }>;
      const previousByExternal = new Map(previous.map((p) => [p.external_id, p.public_id]));
      const seen = new Set<string>();

      for (const [index, payment] of bill.payments.entries()) {
        const externalId = payment.id ?? `${bill.id}:payment:${index}`;
        seen.add(externalId);
        const paymentPublicId = previousByExternal.get(externalId) ?? ulid();
        const paymentDate = billDate(payment.paymentDate);
        if (previousByExternal.has(externalId)) {
          db.prepare(
            `UPDATE bill_payments SET payment_date=?, amount_minor=?, currency_code=?,
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_id=?`
          ).run(paymentDate, toMinor(payment.amount), payment.currencyCode ?? currency, paymentPublicId);
        } else {
          db.prepare(
            `INSERT INTO bill_payments (public_id, external_id, bill_public_id, payment_date,
               amount_minor, currency_code, updated_at)
             VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
          ).run(
            paymentPublicId,
            externalId,
            publicId,
            paymentDate,
            toMinor(payment.amount),
            payment.currencyCode ?? currency
          );
        }
        result.payments += 1;
      }

      for (const [externalId, paymentPublicId] of previousByExternal) {
        if (!seen.has(externalId)) {
          db.prepare('DELETE FROM bill_payments WHERE public_id = ?').run(paymentPublicId);
        }
      }
    }
  });
  run();

  return result;
}
