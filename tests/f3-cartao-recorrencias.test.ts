/**
 * F3 — cartão e recorrências.
 *
 * Cobre o gate da fase (docs/12 §7): fronteiras de 70%, 85% e 95%; fatura
 * confirmada/provisória fechando com as transações do ciclo e sem número de
 * cartão; histórico preservando lacuna; recorrência exigindo amostra mínima
 * com evidência; nenhuma cópia afirmando uso, cancelamento, fraude ou
 * inadimplência; e recálculo no mesmo ciclo sem duplicar evento de outbox.
 */
import { describe, it, expect } from 'vitest';
import {
  addBill,
  addBillPayment,
  addFinanceCharge,
  addRecurringSeries,
  addTx,
  BANK,
  CARD,
  CAT_COMPRAS,
  CAT_TRANSFER,
  makeDb,
  setBillForecast,
  setCardLimit,
} from './fixtures/f2.js';
import { computeCreditCard, limitBand, listBills, CardAccountNotFound } from '../src/finance/creditCard.js';
import { matchBillPayments } from '../src/db/billMatch.js';
import {
  analyzeRecurrences,
  bandFor,
  detectPriceIncrease,
  evaluateSeries,
  listRecurrences,
  median,
  medianAbsoluteDeviation,
} from '../src/finance/recurrences.js';
import { evaluateCardAndRecurrenceEvents } from '../src/finance/events.js';
import { normalizeDescription, normalizeCnpj } from '../src/finance/normalize.js';
import { sanitizeDeep } from '../src/pluggy/sanitize.js';
import { listTransactions } from '../src/finance/transactions.js';
import { resolveCategory } from '../src/jobs/categories.js';

const NOW = new Date('2026-03-15T15:00:00.000Z'); // 2026-03-15 em São Paulo

describe('uso do limite', () => {
  it('as quatro faixas respeitam as fronteiras exatas', () => {
    expect(limitBand(0)).toBe('NORMAL');
    expect(limitBand(69.99)).toBe('NORMAL');
    expect(limitBand(70)).toBe('ATTENTION');
    expect(limitBand(84.99)).toBe('ATTENTION');
    expect(limitBand(85)).toBe('HIGH');
    expect(limitBand(94.99)).toBe('HIGH');
    expect(limitBand(95)).toBe('CRITICAL');
    expect(limitBand(120)).toBe('CRITICAL');
    expect(limitBand(null)).toBe('UNAVAILABLE');
  });

  it('calcula uso e faixa a partir da conta', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 3100);
    addTx(db, { date: '2026-03-02', amount: 10, account: CARD, id: 'tx-cycle' });
    setBillForecast(db, 'tx-cycle', '2026-03');

    const card = computeCreditCard(db, { now: NOW });
    const limit = card.data['limit'] as Record<string, unknown>;
    expect(limit['used']).toBe(1900);
    expect(limit['usedPercent']).toBe(38);
    expect(limit['band']).toBe('NORMAL');
  });

  it('limite ausente ou zero não divide e devolve indisponível', () => {
    const db = makeDb();
    setCardLimit(db, null, null);
    addTx(db, { date: '2026-03-02', amount: 10, account: CARD, id: 'tx-a' });
    setBillForecast(db, 'tx-a', '2026-03');
    const semLimite = computeCreditCard(db, { now: NOW });
    const l1 = semLimite.data['limit'] as Record<string, unknown>;
    expect(l1['usedPercent']).toBeNull();
    expect(l1['band']).toBe('UNAVAILABLE');

    setCardLimit(db, 0, 0);
    const limiteZero = computeCreditCard(db, { now: NOW });
    const l2 = limiteZero.data['limit'] as Record<string, unknown>;
    expect(l2['usedPercent']).toBeNull();
    expect(l2['band']).toBe('UNAVAILABLE');
  });

  it('limites desagregados nunca são marcados como somáveis ao total', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 3100);
    db.prepare(
      `INSERT INTO account_credit_limits (account_public_id, ordinal, credit_line_limit_type,
         consolidation_type, used_amount_minor, limit_amount_minor, available_amount_minor,
         currency_code, updated_at)
       VALUES (?,0,'LIMITE_CREDITO_TOTAL','CONSOLIDADO',190000,500000,310000,'BRL',datetime('now'))`
    ).run(CARD);
    addTx(db, { date: '2026-03-02', amount: 10, account: CARD, id: 'tx-b' });
    setBillForecast(db, 'tx-b', '2026-03');

    const card = computeCreditCard(db, { now: NOW });
    const limit = card.data['limit'] as { components: Array<{ additiveToTotal: boolean }> };
    expect(limit.components).toHaveLength(1);
    expect(limit.components[0]?.additiveToTotal).toBe(false);
  });

  it('sem conta de crédito a rota devolve recurso inexistente', () => {
    const db = makeDb();
    db.prepare('DELETE FROM accounts WHERE public_id = ?').run(CARD);
    expect(() => computeCreditCard(db, { now: NOW })).toThrow(CardAccountNotFound);
  });
});

describe('fatura em formação', () => {
  it('separa POSTED e PENDING, débito e crédito, e fecha com o ciclo', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 4000);
    const ids = [
      addTx(db, { date: '2026-03-02', amount: 100, account: CARD }),
      addTx(db, { date: '2026-03-03', amount: 50, account: CARD, status: 'PENDING' }),
      addTx(db, { date: '2026-03-04', amount: 30, account: CARD, type: 'CREDIT', categoryId: null }),
    ];
    for (const id of ids) setBillForecast(db, id, '2026-03');

    const card = computeCreditCard(db, { now: NOW });
    const bill = card.data['currentBill'] as Record<string, number | string>;
    expect(bill['cycle']).toBe('2026-03');
    expect(bill['debitPosted']).toBe(100);
    expect(bill['debitPending']).toBe(50);
    expect(bill['creditPosted']).toBe(30);
    expect(bill['matchedCardCredits']).toBe(0);
    expect(bill['cardCreditUnclassified']).toBe(30);
    expect(bill['observedNet']).toBe(120);
    // Crédito sem pareamento rebaixa a interpretação, sem virar "estorno".
    expect(bill['quality']).toBe('partial');
    expect(JSON.stringify(card.data)).not.toContain('estorno');
  });

  it('transação sem previsão fica em ciclo não informado, não é atribuída', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 4000);
    const comCiclo = addTx(db, { date: '2026-03-02', amount: 100, account: CARD });
    setBillForecast(db, comCiclo, '2026-03');
    addTx(db, { date: '2026-03-05', amount: 19.9, account: CARD }); // sem billForecastDate

    const card = computeCreditCard(db, { now: NOW });
    const bill = card.data['currentBill'] as Record<string, unknown>;
    expect(bill['debitPosted']).toBe(100);
    expect(bill['cycleUnassigned']).toMatchObject({ transactionCount: 1, absoluteAmount: 19.9 });
    expect(card.counts['cycleUnassigned']).toBe(1);
  });

  it('número de cartão nunca chega ao payload nem ao banco', () => {
    const raw = {
      id: 'tx-1',
      amount: 10,
      creditCardMetadata: { cardNumber: '1234567812345678', payeeMCC: 5812, billForecastDate: '2026-03' },
      paymentData: { payer: { documentNumber: '12345678901', name: 'Fulano' } },
      merchant: { cnpj: '12345678000199', businessName: 'Loja Fictícia' },
      account: { identificationNumber: '9999', identity: 'x', taxNumber: '1' },
    };
    const clean = JSON.stringify(sanitizeDeep(raw));
    for (const canary of ['cardNumber', 'documentNumber', 'identificationNumber', 'identity', 'taxNumber']) {
      expect(clean).not.toContain(canary);
    }
    // O que o produto precisa continua presente.
    expect(clean).toContain('billForecastDate');
    expect(clean).toContain('cnpj');
  });

  it('a composição do ciclo abre por evidências com os mesmos valores', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 4000);
    const a = addTx(db, { date: '2026-03-02', amount: 100, account: CARD });
    const b = addTx(db, { date: '2026-03-03', amount: 25.5, account: CARD });
    setBillForecast(db, a, '2026-03');
    setBillForecast(db, b, '2026-03');

    const card = computeCreditCard(db, { now: NOW });
    const bill = card.data['currentBill'] as Record<string, number>;
    const evidence = listTransactions(db, {
      from: '2026-03-01',
      to: '2026-04-01',
      accountId: CARD,
      status: 'POSTED',
      eligibility: 'SPEND',
      limit: 100,
    });
    const soma = evidence.data.reduce((acc, t) => acc + t.amount, 0);
    expect(Math.round(soma * 100) / 100).toBe(bill['debitPosted']);
  });
});

describe('countdown de vencimento', () => {
  it('futuro, hoje e passado têm estados distintos e nenhum alega inadimplência', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 4000);
    const tx = addTx(db, { date: '2026-03-02', amount: 100, account: CARD });
    setBillForecast(db, tx, '2026-03');

    addBill(db, { dueDate: '2026-03-20', totalMinor: 10_000 });
    const futuro = computeCreditCard(db, { now: NOW }).data['currentBill'] as Record<string, unknown>;
    expect(futuro['daysUntilDue']).toBe(5);
    expect(futuro['dueDateStatus']).toBe('FUTURE');

    const db2 = makeDb();
    setCardLimit(db2, 5000, 4000);
    const tx2 = addTx(db2, { date: '2026-03-02', amount: 100, account: CARD });
    setBillForecast(db2, tx2, '2026-03');
    addBill(db2, { dueDate: '2026-03-15', totalMinor: 10_000 });
    const hoje = computeCreditCard(db2, { now: NOW }).data['currentBill'] as Record<string, unknown>;
    expect(hoje['daysUntilDue']).toBe(0);
    expect(hoje['dueDateStatus']).toBe('TODAY');

    const db3 = makeDb();
    setCardLimit(db3, 5000, 4000);
    const tx3 = addTx(db3, { date: '2026-03-02', amount: 100, account: CARD });
    setBillForecast(db3, tx3, '2026-03');
    addBill(db3, { dueDate: '2026-03-05', totalMinor: 10_000 });
    const passado = computeCreditCard(db3, { now: NOW });
    const bill = passado.data['currentBill'] as Record<string, unknown>;
    expect(bill['daysUntilDue']).toBe(-10);
    expect(bill['dueDateStatus']).toBe('DUE_DATE_PASSED');
    const payload = JSON.stringify(passado.data).toLowerCase();
    for (const proibido of ['inadimpl', 'não paga', 'nao paga', 'unpaid', 'fraude', 'cancelad']) {
      expect(payload).not.toContain(proibido);
    }
  });
});

describe('histórico de faturas', () => {
  it('usa o total da fonte, calcula delta e não estima fatura ausente', () => {
    const db = makeDb();
    addBill(db, { dueDate: '2026-01-07', closingDate: '2025-12-30', totalMinor: 19_742, minimumMinor: 2_961 });
    // Fevereiro sem fatura: lacuna, não barra zero.
    addBill(db, { dueDate: '2026-03-07', closingDate: '2026-02-27', totalMinor: 25_000, minimumMinor: 3_750 });

    const bills = listBills(db, { accountId: CARD, from: '2025-12-01', to: '2026-04-01' });
    expect(bills.data).toHaveLength(2);
    const first = bills.data[0] as Record<string, unknown>;
    expect(first['dueDate']).toBe('2026-03-07');
    expect(first['totalAmount']).toBe(250);
    expect(first['deltaAmount']).toBe(52.58);
    expect(first['minimumPaymentPercent']).toBe(15);
    const meses = bills.data.map((b) => (b as { dueDate: string }).dueDate.slice(0, 7));
    expect(meses).not.toContain('2026-02');
  });

  it('fatura com total zero não divide para achar o mínimo relativo', () => {
    const db = makeDb();
    addBill(db, { dueDate: '2026-03-07', totalMinor: 0, minimumMinor: 0 });
    const bills = listBills(db, { accountId: CARD, from: '2026-01-01', to: '2026-04-01' });
    expect((bills.data[0] as Record<string, unknown>)['minimumPaymentPercent']).toBeNull();
  });

  it('conta que não é de crédito não lista faturas', () => {
    const db = makeDb();
    expect(() => listBills(db, { accountId: BANK, from: '2026-01-01', to: '2026-04-01' })).toThrow(
      CardAccountNotFound
    );
  });

  it('contador de encargos mantém componentes separados e usa o maior', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 4000);
    const tx = addTx(db, { date: '2026-03-02', amount: 100, account: CARD });
    setBillForecast(db, tx, '2026-03');
    const bill = addBill(db, { dueDate: '2026-03-07', closingDate: '2026-02-27', totalMinor: 25_000 });
    addFinanceCharge(db, bill, 'IOF', 1_000);
    addFinanceCharge(db, bill, 'INTEREST', 1_450);
    // Mesmos encargos aparecendo também como transação categorizada.
    addTx(db, { date: '2026-03-03', amount: 8.2, account: CARD, categoryId: '15030000' });
    addTx(db, { date: '2026-03-04', amount: 6.3, account: CARD, categoryId: '02020000' });

    const card = computeCreditCard(db, { now: NOW });
    const costs = card.data['observedCreditCostsYear'] as Record<string, unknown>;
    expect((costs['financeCharges'] as Record<string, number>)['amount']).toBe(24.5);
    expect(costs['overlapStatus']).toBe('UNVERIFIED');
    expect((costs['conservativeTotal'] as Record<string, unknown>)['amount']).toBe(24.5);
    expect((costs['conservativeTotal'] as Record<string, unknown>)['rule']).toBe('MAX_SOURCE_TOTAL');
    // Diagnóstico não aditivo continua visível, mas não é o headline.
    expect(costs['nonAdditiveComponentSum']).toBe(39);
    expect(costs['quality']).toBe('partial');
  });
});

describe('pareamento de pagamento de fatura (MATCH_V1)', () => {
  it('pareia os dois lados com valor exato e distância zero', () => {
    const db = makeDb();
    const bill = addBill(db, { dueDate: '2026-03-10', totalMinor: 50_000 });
    addBillPayment(db, bill, { paymentDate: '2026-03-08', amountMinor: 50_000 });
    const bankDebit = addTx(db, { date: '2026-03-08', amount: 500, categoryId: CAT_TRANSFER });
    const cardCredit = addTx(db, { date: '2026-03-08', amount: 500, account: CARD, type: 'CREDIT', categoryId: null });

    const result = matchBillPayments(db);
    expect(result.matched).toBe(2);
    expect(result.byRole).toEqual({ BANK_DEBIT: 1, CARD_CREDIT: 1 });

    const roles = db
      .prepare('SELECT transaction_public_id, role, confidence FROM transaction_bill_payment_matches ORDER BY role')
      .all() as Array<{ transaction_public_id: string; role: string; confidence: string }>;
    expect(roles.map((r) => r.role)).toEqual(['BANK_DEBIT', 'CARD_CREDIT']);
    expect(roles.every((r) => r.confidence === 'HIGH')).toBe(true);
    expect(roles.find((r) => r.role === 'BANK_DEBIT')?.transaction_public_id).toBe(bankDebit);
    expect(roles.find((r) => r.role === 'CARD_CREDIT')?.transaction_public_id).toBe(cardCredit);
  });

  it('distância de um dia é MEDIUM e valor diferente não casa', () => {
    const db = makeDb();
    const bill = addBill(db, { dueDate: '2026-03-10', totalMinor: 20_000 });
    addBillPayment(db, bill, { paymentDate: '2026-03-08', amountMinor: 20_000 });
    addTx(db, { date: '2026-03-09', amount: 200, categoryId: CAT_TRANSFER });
    addTx(db, { date: '2026-03-09', amount: 199.99, account: CARD, type: 'CREDIT', categoryId: null });

    const result = matchBillPayments(db);
    expect(result.byRole.BANK_DEBIT).toBe(1);
    expect(result.byRole.CARD_CREDIT).toBe(0);
    const row = db.prepare('SELECT confidence FROM transaction_bill_payment_matches').get() as {
      confidence: string;
    };
    expect(row.confidence).toBe('MEDIUM');
  });

  it('empate no menor intervalo deixa a role sem match', () => {
    const db = makeDb();
    const bill = addBill(db, { dueDate: '2026-03-10', totalMinor: 30_000 });
    addBillPayment(db, bill, { paymentDate: '2026-03-08', amountMinor: 30_000 });
    addTx(db, { date: '2026-03-08', amount: 300, categoryId: CAT_TRANSFER });
    addTx(db, { date: '2026-03-08', amount: 300, categoryId: CAT_TRANSFER });

    const result = matchBillPayments(db);
    expect(result.byRole.BANK_DEBIT).toBe(0);
    expect(result.ambiguous).toBeGreaterThan(0);
  });

  it('reexecutar a mesma versão não duplica match', () => {
    const db = makeDb();
    const bill = addBill(db, { dueDate: '2026-03-10', totalMinor: 40_000 });
    addBillPayment(db, bill, { paymentDate: '2026-03-08', amountMinor: 40_000 });
    addTx(db, { date: '2026-03-08', amount: 400, categoryId: CAT_TRANSFER });

    matchBillPayments(db);
    matchBillPayments(db);
    const count = db.prepare('SELECT COUNT(*) AS n FROM transaction_bill_payment_matches').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('pagamento sem data não é processado', () => {
    const db = makeDb();
    const bill = addBill(db, { dueDate: '2026-03-10', totalMinor: 10_000 });
    addBillPayment(db, bill, { paymentDate: null, amountMinor: 10_000 });
    addTx(db, { date: '2026-03-08', amount: 100, categoryId: CAT_TRANSFER });
    const result = matchBillPayments(db);
    expect(result.paymentsConsidered).toBe(0);
    expect(result.matched).toBe(0);
  });
});

describe('recorrências', () => {
  const MENSAL = ['2025-11-05', '2025-12-05', '2026-01-05', '2026-02-05', '2026-03-05'];

  it('cadências têm faixas fechadas e determinísticas', () => {
    expect(bandFor(4)).toBeNull();
    expect(bandFor(5)?.cadence).toBe('WEEKLY');
    expect(bandFor(9)?.cadence).toBe('WEEKLY');
    expect(bandFor(24)).toBeNull();
    expect(bandFor(25)?.cadence).toBe('MONTHLY');
    expect(bandFor(35)?.cadence).toBe('MONTHLY');
    expect(bandFor(50)?.cadence).toBe('BIMONTHLY');
    expect(bandFor(75)?.cadence).toBe('QUARTERLY');
    expect(bandFor(330)?.cadence).toBe('ANNUAL');
    expect(bandFor(401)).toBeNull();
  });

  it('menos de 3 ocorrências não classifica', () => {
    const db = makeDb();
    addRecurringSeries(db, { dates: ['2026-01-05', '2026-02-05'], amounts: [59.9, 59.9] });
    const result = analyzeRecurrences(db, { now: NOW });
    expect(result.seriesPersisted).toBe(0);
  });

  it('série mensal estável vira recorrência ativa com custo anualizado', () => {
    const db = makeDb();
    addRecurringSeries(db, { dates: MENSAL, amounts: [59.9, 59.9, 59.9, 59.9, 59.9] });
    const result = analyzeRecurrences(db, { now: NOW });
    expect(result.seriesPersisted).toBe(1);
    expect(result.statuses.ACTIVE).toBe(1);

    const list = listRecurrences(db, { now: NOW });
    const r = list.data.recurrences[0]!;
    expect(r.cadence).toBe('MONTHLY');
    expect(r.typicalAmount).toBe(59.9);
    expect(r.annualizedCost).toBe(718.8);
    expect(list.data.annualizedTotal.amount).toBe(718.8);
    expect(r.evidence.occurrenceCount).toBe(5);
    expect(r.evidence.transactionRefs).toHaveLength(5);
    expect(r.status).toBe('ACTIVE');
  });

  it('transferência interna e pagamento de fatura não viram recorrência', () => {
    const db = makeDb();
    addRecurringSeries(db, { dates: MENSAL, amounts: [50, 50, 50, 50, 50], categoryId: CAT_TRANSFER });
    const result = analyzeRecurrences(db, { now: NOW });
    expect(result.seriesPersisted).toBe(0);
  });

  it('a chave usa CNPJ quando existe e nunca o documento do pagador', () => {
    const db = makeDb();
    addRecurringSeries(db, {
      dates: MENSAL,
      amounts: [30, 30, 30, 30, 30],
      cnpj: '12345678000199',
      description: 'DESCRICAO QUALQUER',
    });
    analyzeRecurrences(db, { now: NOW });
    const row = db.prepare('SELECT matcher_type, matcher_value FROM recurring_analysis').get() as {
      matcher_type: string;
      matcher_value: string;
    };
    expect(row.matcher_type).toBe('MERCHANT_CNPJ');
    expect(row.matcher_value).toBe('12345678000199');
  });

  it('reajuste só dispara acima do maior limiar e nunca com base zero', () => {
    // Base estável de 54,90 e salto para 59,90 (~9,1%) fica ABAIXO do piso.
    expect(detectPriceIncrease([5490, 5490, 5490, 5990])).toBeNull();
    // Salto de 20% passa.
    const detected = detectPriceIncrease([5490, 5490, 5490, 6588]);
    expect(detected).not.toBeNull();
    expect(detected?.baseMinor).toBe(5490);
    expect(detected?.windowSize).toBe(3);
    // Amostra curta e base zero não classificam.
    expect(detectPriceIncrease([5490, 6588])).toBeNull();
    expect(detectPriceIncrease([0, 0, 0, 100])).toBeNull();
  });

  it('cobrança que some por duas cadências fica DORMANT sem falar em uso', () => {
    const db = makeDb();
    addRecurringSeries(db, {
      dates: ['2025-09-05', '2025-10-05', '2025-11-05', '2025-12-05'],
      amounts: [40, 40, 40, 40],
    });
    const result = analyzeRecurrences(db, { now: NOW });
    expect(result.statuses.DORMANT).toBe(1);

    const list = listRecurrences(db, { now: NOW });
    expect(list.data.recurrences[0]?.status).toBe('DORMANT');
    // DORMANT não entra no total anualizado (docs/09 §6.4).
    expect(list.data.annualizedTotal.amount).toBe(0);
    const payload = JSON.stringify(list.data).toLowerCase();
    for (const proibido of ['não usa', 'nao usa', 'sem uso', 'cancelad', 'fantasma']) {
      expect(payload).not.toContain(proibido);
    }
  });

  it('cobrança que volta após hiato vira RESUMED com o hiato registrado', () => {
    const db = makeDb();
    // Série longa o bastante para a regularidade sobreviver ao hiato: com
    // apenas 3 intervalos, 2/3 = 0,6667 fica abaixo do piso de 0,67 e a
    // série conservadoramente não classifica.
    addRecurringSeries(db, {
      dates: ['2025-08-05', '2025-09-05', '2025-10-05', '2025-11-05', '2025-12-05', '2026-03-10'],
      amounts: [40, 40, 40, 40, 40, 40],
    });
    const result = analyzeRecurrences(db, { now: NOW });
    expect(result.statuses.RESUMED).toBe(1);
    const row = db.prepare('SELECT status, last_gap_days, resumed_at, active FROM recurring_analysis').get() as {
      status: string;
      last_gap_days: number;
      resumed_at: string | null;
      active: number;
    };
    expect(row.status).toBe('RESUMED');
    expect(row.last_gap_days).toBe(95);
    expect(row.resumed_at).not.toBeNull();
    expect(row.active).toBe(1);
  });

  it('mediana e MAD são as usadas nas fórmulas do plano', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(medianAbsoluteDeviation([10, 10, 10])).toBe(0);
    expect(medianAbsoluteDeviation([10, 20, 30])).toBe(10);
  });

  it('normalização de descrição remove só sufixo variável testado', () => {
    expect(normalizeDescription('  netflix   BRASIL ')).toBe('NETFLIX BRASIL');
    expect(normalizeDescription('LOJA X PARCELA 3/12')).toBe('LOJA X');
    expect(normalizeDescription('MERCADO 24H')).toBe('MERCADO 24H');
    expect(normalizeCnpj('12.345.678/0001-99')).toBe('12345678000199');
    expect(normalizeCnpj('123')).toBeNull();
  });

  it('série sem cadência classificável não é persistida', () => {
    const db = makeDb();
    addRecurringSeries(db, {
      dates: ['2026-01-01', '2026-01-15', '2026-02-20'],
      amounts: [10, 10, 10],
    });
    expect(analyzeRecurrences(db, { now: NOW }).seriesPersisted).toBe(0);
  });

  it('mediana de valor menor ou igual a zero deixa a série fora', () => {
    const evaluated = evaluateSeries(
      {
        matcherType: 'DESCRIPTION_RAW_NORMALIZED',
        matcherValue: 'X',
        displayName: 'X',
        occurrences: [
          { publicId: 'a', date: '2026-01-05', amountMinor: 0, categoryId: null, currency: 'BRL' },
          { publicId: 'b', date: '2026-02-05', amountMinor: 0, categoryId: null, currency: 'BRL' },
          { publicId: 'c', date: '2026-03-05', amountMinor: 0, categoryId: null, currency: 'BRL' },
        ],
      } as never,
      '2026-03-15'
    );
    expect(evaluated).toBeNull();
  });
});

describe('eventos da F3', () => {
  it('faixa crítica abre episódio e repetir o cálculo não duplica evento', () => {
    const db = makeDb();
    setCardLimit(db, 1000, 20); // 98% usado

    evaluateCardAndRecurrenceEvents(db, { now: NOW });
    evaluateCardAndRecurrenceEvents(db, { now: NOW });

    const rows = db
      .prepare(
        `SELECT severity, occurrence_count FROM outbox_events
          WHERE event_type = 'CREDIT_LIMIT_BAND_CHANGED' AND condition_closed_at IS NULL`
      )
      .all() as Array<{ severity: string; occurrence_count: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe('CRITICAL');
    expect(rows[0]?.occurrence_count).toBe(2);
  });

  it('voltar para a faixa normal encerra o episódio anterior', () => {
    const db = makeDb();
    setCardLimit(db, 1000, 20);
    evaluateCardAndRecurrenceEvents(db, { now: NOW });
    setCardLimit(db, 1000, 900); // 10% usado
    evaluateCardAndRecurrenceEvents(db, { now: NOW });

    const abertos = db
      .prepare(
        `SELECT COUNT(*) AS n FROM outbox_events
          WHERE event_type = 'CREDIT_LIMIT_BAND_CHANGED' AND condition_closed_at IS NULL`
      )
      .get() as { n: number };
    expect(abertos.n).toBe(0);
  });

  it('vencimento dentro da janela avisa sem afirmar pagamento', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 4000);
    addBill(db, { dueDate: '2026-03-18', totalMinor: 10_000 });
    const result = evaluateCardAndRecurrenceEvents(db, { now: NOW });
    expect(result.billDueEmitted).toBe(true);

    const row = db
      .prepare(`SELECT payload_json FROM outbox_events WHERE event_type = 'BILL_DUE_SOON'`)
      .get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload['daysUntilDue']).toBe(3);
    expect(payload['paymentStatusKnown']).toBe(false);
    expect(row.payload_json.toLowerCase()).not.toContain('inadimpl');
  });

  it('vencimento fora da janela não gera evento', () => {
    const db = makeDb();
    setCardLimit(db, 5000, 4000);
    addBill(db, { dueDate: '2026-04-30', totalMinor: 10_000 });
    const result = evaluateCardAndRecurrenceEvents(db, { now: NOW });
    expect(result.billDueEmitted).toBe(false);
  });

  it('retomada gera evento que só afirma reaparecimento da cobrança', () => {
    const db = makeDb();
    addRecurringSeries(db, {
      dates: ['2025-08-05', '2025-09-05', '2025-10-05', '2025-11-05', '2025-12-05', '2026-03-10'],
      amounts: [40, 40, 40, 40, 40, 40],
    });
    analyzeRecurrences(db, { now: NOW });
    const result = evaluateCardAndRecurrenceEvents(db, { now: NOW });
    expect(result.resumed).toBe(1);

    const row = db
      .prepare(`SELECT payload_json FROM outbox_events WHERE event_type = 'RECURRENCE_RESUMED_AFTER_GAP'`)
      .get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload['claim']).toBe('CHARGE_REAPPEARED_AFTER_GAP');
    expect(row.payload_json).not.toContain('displayName');
  });
});

describe('estado das séries', () => {
  it('série que deixa de qualificar sai do estado na reanálise', () => {
    const db = makeDb();
    const ids = addRecurringSeries(db, {
      dates: ['2025-11-05', '2025-12-05', '2026-01-05', '2026-02-05', '2026-03-05'],
      amounts: [59.9, 59.9, 59.9, 59.9, 59.9],
    });
    expect(analyzeRecurrences(db, { now: NOW }).seriesPersisted).toBe(1);

    // Reclassificar as cobranças como transferência interna derruba a série.
    for (const id of ids) {
      db.prepare('UPDATE transactions SET is_internal_transfer = 1 WHERE public_id = ?').run(id);
    }
    const again = analyzeRecurrences(db, { now: NOW });
    expect(again.seriesPersisted).toBe(0);
    expect(again.seriesRemoved).toBe(1);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM recurring_analysis').get() as { n: number };
    const occurrences = db.prepare('SELECT COUNT(*) AS n FROM recurring_occurrences').get() as { n: number };
    expect(rows.n).toBe(0);
    expect(occurrences.n).toBe(0);
  });

  it('aplicação em investimento não vira custo recorrente', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO categories (id, description, description_translated, level1_prefix)
       VALUES ('03000000','Investments','Investimentos','03')`
    ).run();
    addRecurringSeries(db, {
      dates: ['2025-11-05', '2025-12-05', '2026-01-05', '2026-02-05', '2026-03-05'],
      amounts: [100, 100, 100, 100, 100],
      categoryId: '03000000',
    });
    expect(analyzeRecurrences(db, { now: NOW }).seriesPersisted).toBe(0);
  });
});

describe('taxonomia de categorias', () => {
  it('categoria fora do catálogo vira NULL e conta drift, sem quebrar a FK', () => {
    const db = makeDb();
    const state = { known: new Set(['08000000']), refreshed: true, drift: 0 };
    expect(resolveCategory('08000000', state)).toBe('08000000');
    expect(resolveCategory('99999999', state)).toBeNull();
    expect(resolveCategory(null, state)).toBeNull();
    expect(state.drift).toBe(1);

    // A transação com categoria desconhecida precisa entrar mesmo assim.
    const id = addTx(db, { date: '2026-03-02', amount: 10, categoryId: null });
    const row = db.prepare('SELECT category_id FROM transactions WHERE public_id = ?').get(id) as {
      category_id: string | null;
    };
    expect(row.category_id).toBeNull();
  });
});
