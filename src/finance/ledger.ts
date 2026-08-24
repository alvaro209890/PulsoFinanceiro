/**
 * Razão elegível — fonte ÚNICA de classificação de transação para todas as
 * métricas da F2 (docs/09 §2.2 e docs/05 §8).
 *
 * Regra consolidada de gasto confirmado:
 *  - saída (`DEBIT`) com status `POSTED`;
 *  - fora de transferência interna efetiva (categoria raiz `04`, flag
 *    derivada ou override do usuário);
 *  - ausente de `transaction_bill_payment_matches` em QUALQUER role, isto é,
 *    os dois lados do pagamento de fatura saem do gasto;
 *  - moeda comparável com a moeda base do período.
 *
 * Crédito em conta de cartão sem pareamento NÃO reduz gasto: vira o
 * componente `cardCreditUnclassified` e rebaixa a qualidade para `partial`.
 * `PENDING` nunca entra em realizado; fica em camada provisória separada.
 *
 * Todo valor circula em unidade mínima inteira (centavos).
 */
import type { Db } from '../db/index.js';
import { civilDate, DEFAULT_TIMEZONE } from './time.js';

export interface LedgerRow {
  publicId: string;
  accountPublicId: string;
  accountType: string;
  date: string; // data civil local
  amountMinor: number; // sempre positivo (módulo)
  currencyCode: string;
  status: 'POSTED' | 'PENDING';
  type: 'DEBIT' | 'CREDIT' | null;
  categoryId: string | null;
  rootCode: string;
  categoryLabel: string | null;
  description: string | null;
  orderTiebreak: number | null;
  internalTransfer: boolean;
  billPaymentRole: 'BANK_DEBIT' | 'CARD_CREDIT' | null;
  cardCreditUnclassified: boolean;
  /** saída confirmada elegível a gasto */
  spendPosted: boolean;
  /** saída provisória elegível (camada separada, nunca em realizado) */
  spendPending: boolean;
  /** entrada confirmada elegível */
  incomePosted: boolean;
}

export interface Ledger {
  rows: LedgerRow[];
  currencyCode: string;
  /** moedas distintas observadas — mais de uma torna o período não comparável */
  currencies: string[];
  counts: { records: number; cardCreditUnclassified: number; pending: number };
}

export const NO_CATEGORY_ROOT = '00';
export const INTERNAL_TRANSFER_ROOT = '04';

interface RawRow {
  public_id: string;
  account_public_id: string;
  account_type: string;
  amount: number;
  currency: string;
  date: string;
  status: string;
  type: string | null;
  category_id: string | null;
  category_label: string | null;
  description: string | null;
  order_tiebreak: number | null;
  is_internal_transfer: number;
  bill_role: string | null;
}

/** Converte valor decimal para centavos inteiros com arredondamento meio-acima. */
export function toMinor(amount: number): number {
  return Math.round(Math.abs(amount) * 100);
}

export function fromMinor(minor: number): number {
  return Math.round(minor) / 100;
}

/**
 * Carrega e classifica o período [from, to) — `to` exclusivo.
 * A conversão para data civil acontece aqui, então o filtro SQL usa uma
 * folga de um dia em cada borda e o recorte final é feito em memória.
 */
export function loadLedger(
  db: Db,
  params: { from: string; to: string; timezone?: string }
): Ledger {
  const timezone = params.timezone ?? DEFAULT_TIMEZONE;
  const raw = db
    .prepare(
      `SELECT t.public_id, t.account_public_id, a.type AS account_type, t.amount, t.currency,
              t.date, t.status, t.type, t.category_id, c.description_translated AS category_label,
              t.description, t.order_tiebreak, t.is_internal_transfer,
              m.role AS bill_role
         FROM transactions t
         JOIN accounts a ON a.public_id = t.account_public_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN transaction_bill_payment_matches m ON m.transaction_public_id = t.public_id
        WHERE date(substr(t.date,1,10)) >= date(?, '-1 day')
          AND date(substr(t.date,1,10)) <  date(?, '+1 day')
        ORDER BY t.date ASC, t.order_tiebreak ASC, t.public_id ASC`
    )
    .all(params.from, params.to) as RawRow[];

  const rows: LedgerRow[] = [];
  const currencyCount = new Map<string, number>();

  for (const r of raw) {
    const date = civilDate(r.date, timezone);
    if (date < params.from || date >= params.to) continue;

    const categoryId = r.category_id;
    const rootCode = categoryId ? categoryId.slice(0, 2) : NO_CATEGORY_ROOT;
    const internalTransfer = r.is_internal_transfer === 1 || rootCode === INTERNAL_TRANSFER_ROOT;
    const billPaymentRole =
      r.bill_role === 'BANK_DEBIT' || r.bill_role === 'CARD_CREDIT' ? r.bill_role : null;
    const status = r.status === 'PENDING' ? 'PENDING' : 'POSTED';
    const type = r.type === 'DEBIT' || r.type === 'CREDIT' ? r.type : null;
    const excluded = internalTransfer || billPaymentRole !== null;
    const cardCreditUnclassified =
      type === 'CREDIT' && r.account_type === 'CREDIT' && billPaymentRole === null && !internalTransfer;

    currencyCount.set(r.currency, (currencyCount.get(r.currency) ?? 0) + 1);

    rows.push({
      publicId: r.public_id,
      accountPublicId: r.account_public_id,
      accountType: r.account_type,
      date,
      amountMinor: toMinor(r.amount),
      currencyCode: r.currency,
      status,
      type,
      categoryId,
      rootCode,
      categoryLabel: r.category_label,
      description: r.description,
      orderTiebreak: r.order_tiebreak,
      internalTransfer,
      billPaymentRole,
      cardCreditUnclassified,
      spendPosted: type === 'DEBIT' && status === 'POSTED' && !excluded,
      spendPending: type === 'DEBIT' && status === 'PENDING' && !excluded,
      incomePosted: type === 'CREDIT' && status === 'POSTED' && !excluded && r.account_type !== 'CREDIT',
    });
  }

  const currencies = [...currencyCount.keys()].sort();
  const dominant = [...currencyCount.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    rows,
    currencyCode: dominant?.[0] ?? 'BRL',
    currencies,
    counts: {
      records: rows.length,
      cardCreditUnclassified: rows.filter((r) => r.cardCreditUnclassified).length,
      pending: rows.filter((r) => r.status === 'PENDING').length,
    },
  };
}

/** Soma em centavos das saídas confirmadas elegíveis. */
export function sumSpendPosted(rows: readonly LedgerRow[]): number {
  let total = 0;
  for (const r of rows) if (r.spendPosted) total += r.amountMinor;
  return total;
}

/** Soma em centavos das saídas provisórias elegíveis. */
export function sumSpendPending(rows: readonly LedgerRow[]): number {
  let total = 0;
  for (const r of rows) if (r.spendPending) total += r.amountMinor;
  return total;
}

/** Soma em centavos das entradas confirmadas elegíveis. */
export function sumIncomePosted(rows: readonly LedgerRow[]): number {
  let total = 0;
  for (const r of rows) if (r.incomePosted) total += r.amountMinor;
  return total;
}
