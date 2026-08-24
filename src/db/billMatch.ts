/**
 * Pareamento de pagamento de fatura — algoritmo fechado e versionado
 * `MATCH_V1` (docs/05 §`credit_card_bills`, encargos e pagamentos).
 *
 * 1. só processa pagamento com `payment_date`, valor e moeda válidos;
 * 2. `BANK_DEBIT`: transações `POSTED/DEBIT` de conta `BANK` do mesmo Item;
 *    `CARD_CREDIT`: `POSTED/CREDIT` da conta de cartão da própria fatura;
 * 3. candidato precisa ter a mesma moeda, valor absoluto EXATAMENTE igual e
 *    data civil (America/Sao_Paulo) no mesmo dia ou a um dia de distância;
 * 4. vence o ÚNICO candidato de menor distância: 0 dia → HIGH, 1 dia →
 *    MEDIUM. Empate, candidato já ocupado ou qualquer incompatibilidade
 *    deixa a role sem match — descrição e merchant não desempatam;
 * 5. `evidence_json` guarda só moeda, números, distância e IDs locais.
 *
 * Reexecutar a mesma versão substitui deterministicamente apenas os matches
 * derivados por ela.
 */
import type { Db } from './index.js';
import { ulid } from 'ulid';
import { civilDate, daysBetween, DEFAULT_TIMEZONE } from '../finance/time.js';

export const BILL_MATCH_ALGORITHM_VERSION = 'MATCH_V1';

export interface MatchResult {
  paymentsConsidered: number;
  matched: number;
  ambiguous: number;
  byRole: { BANK_DEBIT: number; CARD_CREDIT: number };
}

interface PaymentRow {
  public_id: string;
  bill_public_id: string;
  payment_date: string | null;
  amount_minor: number;
  currency_code: string;
  card_account_public_id: string;
  item_public_id: string;
}

interface CandidateRow {
  public_id: string;
  date: string;
  amount: number;
  currency: string;
}

export function matchBillPayments(
  db: Db,
  options: { timezone?: string } = {}
): MatchResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const result: MatchResult = {
    paymentsConsidered: 0,
    matched: 0,
    ambiguous: 0,
    byRole: { BANK_DEBIT: 0, CARD_CREDIT: 0 },
  };

  const payments = db
    .prepare(
      `SELECT p.public_id, p.bill_public_id, p.payment_date, p.amount_minor, p.currency_code,
              b.account_public_id AS card_account_public_id, a.item_public_id
         FROM bill_payments p
         JOIN credit_card_bills b ON b.public_id = p.bill_public_id
         JOIN accounts a ON a.public_id = b.account_public_id
        ORDER BY p.payment_date ASC, p.public_id ASC`
    )
    .all() as PaymentRow[];

  const run = db.transaction(() => {
    // Reexecução determinística: derrubar só o que esta versão derivou.
    db.prepare('DELETE FROM transaction_bill_payment_matches WHERE algorithm_version = ?').run(
      BILL_MATCH_ALGORITHM_VERSION
    );

    const taken = new Set<string>();

    for (const payment of payments) {
      if (!payment.payment_date || payment.amount_minor <= 0 || !payment.currency_code) continue;
      result.paymentsConsidered += 1;
      const paymentDay = payment.payment_date.slice(0, 10);

      for (const role of ['BANK_DEBIT', 'CARD_CREDIT'] as const) {
        const candidates = (
          role === 'BANK_DEBIT'
            ? db
                .prepare(
                  `SELECT t.public_id, t.date, t.amount, t.currency
                     FROM transactions t
                     JOIN accounts a ON a.public_id = t.account_public_id
                    WHERE a.type = 'BANK' AND a.item_public_id = ?
                      AND t.status = 'POSTED' AND t.type = 'DEBIT' AND t.currency = ?`
                )
                .all(payment.item_public_id, payment.currency_code)
            : db
                .prepare(
                  `SELECT t.public_id, t.date, t.amount, t.currency
                     FROM transactions t
                    WHERE t.account_public_id = ?
                      AND t.status = 'POSTED' AND t.type = 'CREDIT' AND t.currency = ?`
                )
                .all(payment.card_account_public_id, payment.currency_code)
        ) as CandidateRow[];

        const viable = candidates
          .filter((c) => !taken.has(`${role}:${c.public_id}`))
          .map((c) => ({
            candidate: c,
            distance: Math.abs(daysBetween(civilDate(c.date, timezone), paymentDay)),
            amountMinor: Math.round(Math.abs(c.amount) * 100),
          }))
          .filter((c) => c.amountMinor === payment.amount_minor && c.distance <= 1);

        if (viable.length === 0) continue;

        const best = Math.min(...viable.map((c) => c.distance));
        const winners = viable.filter((c) => c.distance === best);
        if (winners.length !== 1) {
          // Empate no menor intervalo deixa a role sem match e degrada a
          // qualidade: adivinhar aqui seria inventar liquidação.
          result.ambiguous += 1;
          continue;
        }

        const winner = winners[0]!;
        db.prepare(
          `INSERT INTO transaction_bill_payment_matches
             (id, bill_payment_public_id, transaction_public_id, role, confidence, evidence_json,
              algorithm_version, matched_at)
           VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).run(
          ulid(),
          payment.public_id,
          winner.candidate.public_id,
          role,
          winner.distance === 0 ? 'HIGH' : 'MEDIUM',
          JSON.stringify({
            currencyCode: payment.currency_code,
            paymentAmountMinor: payment.amount_minor,
            candidateAmountMinor: winner.amountMinor,
            deltaMinor: 0,
            dayDistance: winner.distance,
            billPaymentPublicId: payment.public_id,
            transactionPublicId: winner.candidate.public_id,
          }),
          BILL_MATCH_ALGORITHM_VERSION
        );
        taken.add(`${role}:${winner.candidate.public_id}`);
        result.matched += 1;
        result.byRole[role] += 1;
      }
    }
  });
  run();

  return result;
}
