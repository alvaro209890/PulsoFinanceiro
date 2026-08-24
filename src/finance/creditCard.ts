/**
 * Cartão — docs/09 §5.1 a §5.5 e contratos `GET /api/v1/credit-card` e
 * `GET /api/v1/bills` (docs/07).
 *
 * Faixas do limite: normal < 70%, atenção 70–84,99%, alta 85–94,99%,
 * crítica ≥ 95%. Limite ausente ou ≤ 0 devolve indisponível — nunca divide.
 *
 * A fatura em formação é agrupada por `creditCardMetadata.billForecastDate`
 * (no tenant medido chega como `YYYY-MM`). Transação sem previsão vai para
 * "ciclo não informado" e NÃO é atribuída em silêncio.
 *
 * Encargos: enquanto a sobreposição entre fatura e extrato não estiver
 * provada, o headline é `max(soma dos encargos das faturas, soma das
 * transações POSTED nas categorias 15030000/02020000)` — os componentes
 * ficam visíveis e não são somados.
 */
import type { Db } from '../db/index.js';
import { civilDate, daysBetween, DEFAULT_TIMEZONE, today as todayCivil } from './time.js';
import { fromMinor } from './ledger.js';
import { worstQuality, type Quality } from './envelope.js';
import { MetricNotAvailable } from './pace.js';

export const CREDIT_CARD_METRIC_VERSION = 'credit-card.v1';
export const BILLS_METRIC_VERSION = 'bills-history.v1';

export type LimitBand = 'NORMAL' | 'ATTENTION' | 'HIGH' | 'CRITICAL' | 'UNAVAILABLE';

/** Categorias de encargo financeiro observadas na taxonomia da Pluggy. */
export const FINANCE_CHARGE_CATEGORY_IDS = ['15030000', '02020000'] as const;

/** Faixa do uso do limite — fronteiras fechadas (docs/09 §5.1). */
export function limitBand(usedPercent: number | null): LimitBand {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return 'UNAVAILABLE';
  if (usedPercent >= 95) return 'CRITICAL';
  if (usedPercent >= 85) return 'HIGH';
  if (usedPercent >= 70) return 'ATTENTION';
  return 'NORMAL';
}

export interface CardAccount {
  publicId: string;
  label: string;
  currency: string;
  creditLimit: number | null;
  availableCreditLimit: number | null;
  balanceDueDate: string | null;
  level: string | null;
  brand: string | null;
}

/** Conta de cartão do Item; `null` quando o produto não existe. */
export function findCardAccount(db: Db): CardAccount | null {
  const row = db
    .prepare(
      `SELECT public_id, label, currency, credit_limit, available_credit_limit,
              balance_due_date, credit_level, credit_brand
         FROM accounts WHERE type = 'CREDIT' ORDER BY public_id LIMIT 1`
    )
    .get() as
    | {
        public_id: string;
        label: string;
        currency: string;
        credit_limit: number | null;
        available_credit_limit: number | null;
        balance_due_date: string | null;
        credit_level: string | null;
        credit_brand: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    publicId: row.public_id,
    label: row.label,
    currency: row.currency,
    creditLimit: row.credit_limit,
    availableCreditLimit: row.available_credit_limit,
    balanceDueDate: row.balance_due_date,
    level: row.credit_level,
    brand: row.credit_brand,
  };
}

export interface CreditCardResult {
  period: { from: string; to: string; timezone: string };
  currencyCode: string;
  counts: Record<string, number>;
  quality: Quality;
  data: Record<string, unknown>;
}

export interface CreditCardOptions {
  billMonth?: string | undefined;
  timezone?: string | undefined;
  now?: Date | undefined;
}

export function computeCreditCard(db: Db, options: CreditCardOptions = {}): CreditCardResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? new Date();
  const currentDay = todayCivil(timezone, now);
  const account = findCardAccount(db);
  if (!account) throw new CardAccountNotFound();

  // ---- Limite -------------------------------------------------------------
  const total = account.creditLimit;
  const available = account.availableCreditLimit;
  const used = total !== null && available !== null ? Math.round((total - available) * 100) / 100 : null;
  const usedPercent =
    total !== null && total > 0 && used !== null ? Math.round((used / total) * 10_000) / 100 : null;
  const band = limitBand(usedPercent);

  const components = (
    db
      .prepare(
        `SELECT ordinal, credit_line_limit_type, consolidation_type, used_amount_minor,
                limit_amount_minor, available_amount_minor, currency_code
           FROM account_credit_limits WHERE account_public_id = ? ORDER BY ordinal`
      )
      .all(account.publicId) as Array<{
        ordinal: number;
        credit_line_limit_type: string | null;
        consolidation_type: string | null;
        used_amount_minor: number | null;
        limit_amount_minor: number | null;
        available_amount_minor: number | null;
        currency_code: string | null;
      }>
  ).map((c) => ({
    lineType: c.credit_line_limit_type,
    consolidationType: c.consolidation_type,
    used: c.used_amount_minor === null ? null : fromMinor(c.used_amount_minor),
    limit: c.limit_amount_minor === null ? null : fromMinor(c.limit_amount_minor),
    available: c.available_amount_minor === null ? null : fromMinor(c.available_amount_minor),
    currencyCode: c.currency_code ?? account.currency,
    // Recorte do mesmo limite: nunca somado ao total (docs/09 §5.1).
    additiveToTotal: false,
    metricId: `credit-limit-component:${account.publicId}:${c.ordinal}`,
  }));

  // ---- Ciclo --------------------------------------------------------------
  const cycles = db
    .prepare(
      `SELECT bill_forecast_date AS cycle, COUNT(*) AS n
         FROM transactions
        WHERE account_public_id = ? AND bill_forecast_date IS NOT NULL
        GROUP BY bill_forecast_date ORDER BY bill_forecast_date DESC`
    )
    .all(account.publicId) as Array<{ cycle: string; n: number }>;

  const cycle = options.billMonth ?? cycles[0]?.cycle ?? null;
  if (!cycle) throw new MetricNotAvailable('CYCLE_NOT_IDENTIFIABLE');

  const cycleRows = db
    .prepare(
      `SELECT t.public_id, t.amount, t.status, t.type, t.category_id, m.role AS bill_role
         FROM transactions t
         LEFT JOIN transaction_bill_payment_matches m ON m.transaction_public_id = t.public_id
        WHERE t.account_public_id = ? AND t.bill_forecast_date = ?`
    )
    .all(account.publicId, cycle) as Array<{
      public_id: string;
      amount: number;
      status: string;
      type: string | null;
      category_id: string | null;
      bill_role: string | null;
    }>;

  let debitPosted = 0;
  let debitPending = 0;
  let creditPosted = 0;
  let creditPending = 0;
  let matchedCardCredits = 0;
  let cardCreditUnclassified = 0;
  const byCategory = new Map<string, { posted: number; pending: number }>();

  for (const r of cycleRows) {
    const minor = Math.round(Math.abs(r.amount) * 100);
    if (r.type === 'DEBIT') {
      if (r.status === 'POSTED') {
        debitPosted += minor;
        const key = r.category_id ?? 'sem-categoria';
        const acc = byCategory.get(key) ?? { posted: 0, pending: 0 };
        acc.posted += minor;
        byCategory.set(key, acc);
      } else {
        debitPending += minor;
        const key = r.category_id ?? 'sem-categoria';
        const acc = byCategory.get(key) ?? { posted: 0, pending: 0 };
        acc.pending += minor;
        byCategory.set(key, acc);
      }
    } else if (r.type === 'CREDIT') {
      if (r.status === 'POSTED') creditPosted += minor;
      else creditPending += minor;
      // Crédito pareado é liquidação; sem par é ajuste NÃO classificado —
      // jamais rotulado como estorno (docs/09 §5.2).
      if (r.bill_role === 'CARD_CREDIT') matchedCardCredits += minor;
      else cardCreditUnclassified += minor;
    }
  }

  const unassigned = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(ABS(amount)),0) AS total
         FROM transactions
        WHERE account_public_id = ? AND bill_forecast_date IS NULL`
    )
    .get(account.publicId) as { n: number; total: number };

  // ---- Fatura aberta e countdown -----------------------------------------
  const openBill = db
    .prepare(
      `SELECT public_id, due_date, bill_closing_date, total_amount_minor
         FROM credit_card_bills
        WHERE account_public_id = ? AND due_date >= ?
        ORDER BY due_date ASC LIMIT 1`
    )
    .get(account.publicId, currentDay) as
    | { public_id: string; due_date: string; bill_closing_date: string | null; total_amount_minor: number }
    | undefined;

  const lastBill = db
    .prepare(
      `SELECT public_id, due_date, bill_closing_date, total_amount_minor
         FROM credit_card_bills
        WHERE account_public_id = ?
        ORDER BY due_date DESC LIMIT 1`
    )
    .get(account.publicId) as
    | { public_id: string; due_date: string; bill_closing_date: string | null; total_amount_minor: number }
    | undefined;

  const referenceBill = openBill ?? lastBill;
  const dueDate = referenceBill?.due_date ?? null;
  const daysUntilDue = dueDate === null ? null : daysBetween(currentDay, dueDate);

  // ---- Encargos observados no ano ----------------------------------------
  const year = currentDay.slice(0, 4);
  const charges = db
    .prepare(
      `SELECT COALESCE(SUM(c.amount_minor),0) AS total, COUNT(*) AS n
         FROM bill_finance_charges c
         JOIN credit_card_bills b ON b.public_id = c.bill_public_id
        WHERE b.account_public_id = ?
          AND substr(COALESCE(b.bill_closing_date, b.due_date),1,4) = ?`
    )
    .get(account.publicId, year) as { total: number; n: number };

  const chargeCategories = FINANCE_CHARGE_CATEGORY_IDS.map((categoryId) => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(ABS(amount)),0) AS total, COUNT(*) AS n
           FROM transactions
          WHERE status = 'POSTED' AND type = 'DEBIT' AND category_id = ?
            AND substr(date,1,4) = ?`
      )
      .get(categoryId, year) as { total: number; n: number };
    return {
      categoryId,
      amount: Math.round(row.total * 100) / 100,
      count: row.n,
      metricIds: {
        amount: `credit-cost-category:${categoryId}:${year}`,
        count: `credit-cost-category-count:${categoryId}:${year}`,
      },
    };
  });

  const categorySumMinor = Math.round(chargeCategories.reduce((acc, c) => acc + c.amount, 0) * 100);
  const conservativeMinor = Math.max(charges.total, categorySumMinor);

  const cardCreditUnclassifiedCount = cycleRows.filter(
    (r) => r.type === 'CREDIT' && r.bill_role !== 'CARD_CREDIT'
  ).length;

  const cycleQuality = worstQuality(
    cardCreditUnclassified > 0 ? 'partial' : 'complete',
    unassigned.n > 0 ? 'partial' : 'complete'
  );
  const quality = worstQuality(
    cycleQuality,
    band === 'UNAVAILABLE' ? 'partial' : 'complete',
    'partial' // overlapStatus UNVERIFIED mantém o contador de encargos parcial
  );

  const history = (
    db
      .prepare(
        `SELECT due_date, bill_closing_date, total_amount_minor
           FROM credit_card_bills WHERE account_public_id = ?
          ORDER BY due_date DESC LIMIT 12`
      )
      .all(account.publicId) as Array<{
        due_date: string;
        bill_closing_date: string | null;
        total_amount_minor: number;
      }>
  ).map((b) => ({
    month: (b.bill_closing_date ?? b.due_date).slice(0, 7),
    dueDate: b.due_date,
    closingDate: b.bill_closing_date,
    totalAmount: fromMinor(b.total_amount_minor),
    metricIds: {
      dueDate: `bill-due:${account.publicId}:${b.due_date}`,
      totalAmount: `bill-total:${account.publicId}:${(b.bill_closing_date ?? b.due_date).slice(0, 7)}`,
    },
  }));

  return {
    period: { from: `${cycle}-01`, to: `${year}-12-31`, timezone },
    currencyCode: account.currency,
    counts: {
      bills: history.length,
      financeCharges: charges.n,
      categorizedCostTransactions: chargeCategories.reduce((acc, c) => acc + c.count, 0),
      cardCreditsUnclassified: cardCreditUnclassifiedCount,
      cycleTransactions: cycleRows.length,
      cycleUnassigned: unassigned.n,
    },
    quality,
    data: {
      accountId: account.publicId,
      label: account.label,
      level: account.level,
      brand: account.brand,
      limit: {
        total,
        available,
        used,
        usedPercent,
        band,
        metricIds: {
          total: `credit-limit-total:${account.publicId}`,
          available: `credit-limit-available:${account.publicId}`,
          used: `credit-limit-used:${account.publicId}`,
          usedPercent: `credit-limit-used-percent:${account.publicId}`,
        },
        components,
      },
      currentBill: {
        cycle,
        debitPosted: fromMinor(debitPosted),
        debitPending: fromMinor(debitPending),
        creditPosted: fromMinor(creditPosted),
        creditPending: fromMinor(creditPending),
        matchedCardCredits: fromMinor(matchedCardCredits),
        cardCreditUnclassified: fromMinor(cardCreditUnclassified),
        observedNet: fromMinor(debitPosted + debitPending - creditPosted - creditPending),
        dueDate,
        daysUntilDue,
        // A fonte não informa confirmação de pagamento: data passada NÃO
        // autoriza falar em inadimplência (docs/09 §5.5).
        dueDateStatus:
          daysUntilDue === null
            ? 'UNKNOWN'
            : daysUntilDue > 0
              ? 'FUTURE'
              : daysUntilDue === 0
                ? 'TODAY'
                : 'DUE_DATE_PASSED',
        isForming: openBill === undefined,
        quality: cycleQuality,
        categoryBreakdown: [...byCategory.entries()]
          .map(([categoryId, v]) => ({
            categoryId: categoryId === 'sem-categoria' ? null : categoryId,
            debitPosted: fromMinor(v.posted),
            debitPending: fromMinor(v.pending),
            metricIds: {
              debitPosted: `current-bill-category-debit-posted:${categoryId}:${cycle}`,
              debitPending: `current-bill-category-debit-pending:${categoryId}:${cycle}`,
            },
          }))
          .sort((a, b) => b.debitPosted - a.debitPosted),
        cycleUnassigned: {
          transactionCount: unassigned.n,
          absoluteAmount: Math.round(unassigned.total * 100) / 100,
          metricIds: {
            transactionCount: `current-bill-cycle-unassigned-count:${cycle}`,
            absoluteAmount: `current-bill-cycle-unassigned-amount:${cycle}`,
          },
        },
        metricIds: {
          debitPosted: `current-bill-debit-posted:${account.publicId}:${cycle}`,
          debitPending: `current-bill-debit-pending:${account.publicId}:${cycle}`,
          creditPosted: `current-bill-credit-posted:${account.publicId}:${cycle}`,
          creditPending: `current-bill-credit-pending:${account.publicId}:${cycle}`,
          matchedCardCredits: `current-bill-matched-card-credits:${account.publicId}:${cycle}`,
          cardCreditUnclassified: `current-bill-card-credit-unclassified:${account.publicId}:${cycle}`,
          observedNet: `current-bill-observed-net:${account.publicId}:${cycle}`,
          dueDate: dueDate ? `bill-due:${account.publicId}:${dueDate}` : `bill-due:${account.publicId}:none`,
          daysUntilDue: `current-bill-days-until-due:${account.publicId}:${cycle}`,
        },
      },
      observedCreditCostsYear: {
        year,
        financeCharges: {
          amount: fromMinor(charges.total),
          count: charges.n,
          metricIds: {
            amount: `credit-cost-finance-charges:${year}`,
            count: `credit-cost-finance-charge-count:${year}`,
          },
        },
        categoryTransactions: chargeCategories,
        overlapStatus: 'UNVERIFIED',
        quality: 'partial',
        conservativeTotal: {
          amount: fromMinor(conservativeMinor),
          rule: 'MAX_SOURCE_TOTAL',
          metricId: `credit-cost-conservative-total:${year}`,
        },
        /** Diagnóstico não aditivo: a soma bruta NÃO é chamada de custo total. */
        nonAdditiveComponentSum: fromMinor(charges.total + categorySumMinor),
      },
      history,
    },
  };
}

export class CardAccountNotFound extends Error {}

// ---------------------------------------------------------------------------
// Histórico de faturas
// ---------------------------------------------------------------------------

export interface BillsResult {
  period: { from: string; to: string; timezone: string };
  currencyCode: string;
  counts: Record<string, number>;
  quality: Quality;
  data: unknown[];
}

export function listBills(
  db: Db,
  options: { accountId: string; from: string; to: string; timezone?: string }
): BillsResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const account = db
    .prepare('SELECT public_id, type, currency FROM accounts WHERE public_id = ?')
    .get(options.accountId) as { public_id: string; type: string; currency: string } | undefined;
  if (!account || account.type !== 'CREDIT') throw new CardAccountNotFound();

  const rows = db
    .prepare(
      `SELECT public_id, due_date, bill_closing_date, total_amount_minor, currency_code,
              minimum_payment_amount_minor, allows_installments
         FROM credit_card_bills
        WHERE account_public_id = ? AND due_date >= ? AND due_date < ?
        ORDER BY due_date DESC, public_id DESC`
    )
    .all(options.accountId, options.from, options.to) as Array<{
      public_id: string;
      due_date: string;
      bill_closing_date: string | null;
      total_amount_minor: number;
      currency_code: string;
      minimum_payment_amount_minor: number | null;
      allows_installments: number | null;
    }>;

  let financeChargeCount = 0;
  let matchedPaymentCount = 0;

  const data = rows.map((bill, index) => {
    // Delta contra a fatura imediatamente anterior em vencimento; a lista já
    // vem em ordem decrescente, então a anterior é a próxima da lista.
    const previous = rows[index + 1];
    const deltaMinor = previous ? bill.total_amount_minor - previous.total_amount_minor : null;
    const minimumPercent =
      bill.minimum_payment_amount_minor !== null && bill.total_amount_minor > 0
        ? Math.round((bill.minimum_payment_amount_minor / bill.total_amount_minor) * 1_000_000) / 10_000
        : null;

    const charges = db
      .prepare(
        `SELECT type, amount_minor FROM bill_finance_charges WHERE bill_public_id = ? ORDER BY type`
      )
      .all(bill.public_id) as Array<{ type: string; amount_minor: number }>;
    financeChargeCount += charges.length;

    const payments = db
      .prepare(
        `SELECT public_id, payment_date, amount_minor FROM bill_payments
          WHERE bill_public_id = ? ORDER BY payment_date`
      )
      .all(bill.public_id) as Array<{ public_id: string; payment_date: string | null; amount_minor: number }>;

    const matches = db
      .prepare(
        `SELECT m.transaction_public_id, m.role, m.confidence
           FROM transaction_bill_payment_matches m
           JOIN bill_payments p ON p.public_id = m.bill_payment_public_id
          WHERE p.bill_public_id = ?
          ORDER BY m.role`
      )
      .all(bill.public_id) as Array<{ transaction_public_id: string; role: string; confidence: string }>;
    matchedPaymentCount += matches.length;

    const month = (bill.bill_closing_date ?? bill.due_date).slice(0, 7);
    return {
      accountId: options.accountId,
      dueDate: bill.due_date,
      closingDate: bill.bill_closing_date,
      totalAmount: fromMinor(bill.total_amount_minor),
      deltaAmount: deltaMinor === null ? null : fromMinor(deltaMinor),
      minimumPaymentAmount:
        bill.minimum_payment_amount_minor === null ? null : fromMinor(bill.minimum_payment_amount_minor),
      minimumPaymentPercent: minimumPercent,
      currencyCode: bill.currency_code,
      allowsInstallments: bill.allows_installments === null ? null : bill.allows_installments === 1,
      metricIds: {
        dueDate: `bill-due:${options.accountId}:${bill.due_date}`,
        closingDate: `bill-closing-date:${options.accountId}:${month}`,
        totalAmount: `bill-total:${options.accountId}:${month}`,
        deltaAmount: `bill-delta:${options.accountId}:${month}`,
        minimumPaymentAmount: `bill-minimum-payment:${options.accountId}:${month}`,
        minimumPaymentPercent: `bill-minimum-payment-percent:${options.accountId}:${month}`,
      },
      financeCharges: charges.map((c) => ({
        type: c.type,
        amount: fromMinor(c.amount_minor),
        metricId: `bill-finance-charge:${options.accountId}:${month}:${c.type}`,
      })),
      providerPayments: payments.map((p) => ({
        paymentDate: p.payment_date,
        amount: fromMinor(p.amount_minor),
      })),
      matchedPaymentTransactions: matches.map((m) => ({
        transactionId: m.transaction_public_id,
        role: m.role,
        confidence: m.confidence,
      })),
    };
  });

  return {
    period: { from: options.from, to: options.to, timezone },
    currencyCode: account.currency,
    counts: {
      bills: data.length,
      financeCharges: financeChargeCount,
      matchedPayments: matchedPaymentCount,
    },
    // Mês sem fatura devolvida é lacuna, não barra zero: a ausência aparece
    // como período sem linha e a qualidade não é inflada.
    quality: data.length === 0 ? 'insufficient' : 'complete',
    data,
  };
}

/** Data civil de um instante — reexportada para uso nos eventos. */
export function civilOf(value: string, timezone = DEFAULT_TIMEZONE): string {
  return civilDate(value, timezone);
}
