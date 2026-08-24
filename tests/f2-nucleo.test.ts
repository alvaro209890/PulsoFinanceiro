/**
 * F2 — núcleo financeiro determinístico.
 *
 * Cobre o gate da fase (docs/12 §6): composição fecha com cada card em mês
 * completo, parcial, com crédito de cartão classificado/não classificado e
 * com `PENDING`; prefixo `04`, override e pagamento de fatura não inflam
 * gasto; mês parcial compara os mesmos dias; base zero não gera infinito;
 * patrimônio mostra lacuna antes do primeiro snapshot; moeda incompatível,
 * histórico insuficiente e cobertura parcial têm contrato próprio.
 */
import { describe, it, expect } from 'vitest';
import {
  addBillPaymentMatch,
  addSnapshot,
  addSyncRun,
  addTx,
  BANK,
  CARD,
  CAT_ALIMENTACAO,
  CAT_COMPRAS,
  CAT_TRANSFER,
  CAT_VESTUARIO,
  insertAccount,
  makeDb,
  seedMonthlySpend,
} from './fixtures/f2.js';
import { loadLedger, sumSpendPosted, toMinor } from '../src/finance/ledger.js';
import { computePace, MetricNotAvailable } from '../src/finance/pace.js';
import { computeCategories, previousComparableWindow } from '../src/finance/categories.js';
import { computeOverview } from '../src/finance/overview.js';
import { listTransactions } from '../src/finance/transactions.js';
import { captureDailySnapshots } from '../src/db/snapshots.js';
import { evaluatePaceEvent } from '../src/finance/events.js';
import { civilDate } from '../src/finance/time.js';

/** 2026-03-15 12:00 em São Paulo. */
const NOW = new Date('2026-03-15T15:00:00.000Z');
const MONTH = '2026-03';
const HISTORY = ['2025-12', '2026-01', '2026-02'] as const;

describe('razão elegível (regra consolidada de gasto)', () => {
  it('exclui prefixo 04, flag de transferência e os DOIS lados do pagamento de fatura', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-02', amount: 100, categoryId: CAT_COMPRAS });
    addTx(db, { date: '2026-03-03', amount: 900, categoryId: CAT_TRANSFER });
    addTx(db, { date: '2026-03-04', amount: 700, categoryId: CAT_COMPRAS, internalTransfer: true });
    const bankDebit = addTx(db, { date: '2026-03-05', amount: 500, categoryId: CAT_COMPRAS });
    const cardCredit = addTx(db, {
      date: '2026-03-05',
      amount: 500,
      account: CARD,
      type: 'CREDIT',
      categoryId: null,
    });
    addBillPaymentMatch(db, {
      bankTxId: bankDebit,
      cardTxId: cardCredit,
      amountMinor: 50_000,
      dueDate: '2026-03-10',
    });

    const ledger = loadLedger(db, { from: '2026-03-01', to: '2026-04-01' });
    expect(sumSpendPosted(ledger.rows)).toBe(toMinor(100));
    expect(ledger.counts.cardCreditUnclassified).toBe(0);
  });

  it('crédito de cartão sem pareamento não reduz gasto e rebaixa a qualidade', () => {
    const db = makeDb();
    seedMonthlySpend(db, HISTORY, 5, 200);
    addTx(db, { date: '2026-03-05', amount: 200, categoryId: CAT_COMPRAS });
    addTx(db, { date: '2026-03-06', amount: 80, account: CARD, type: 'CREDIT', categoryId: null });

    const pace = computePace(db, { month: MONTH, now: NOW });
    expect(pace.data.confirmedSpend.amount).toBe(200);
    expect(pace.quality).toBe('partial');
    expect(pace.data.forecast.reasonCodes).toContain('CARD_CREDIT_UNCLASSIFIED');

    const rows = listTransactions(db, { from: '2026-03-01', to: '2026-04-01' });
    const credit = rows.data.find((t) => t.type === 'CREDIT');
    expect(credit?.cardCreditClassification).toBe('UNCLASSIFIED');
  });

  it('PENDING fica em camada separada e nunca entra em realizado', () => {
    const db = makeDb();
    seedMonthlySpend(db, HISTORY, 5, 200);
    addTx(db, { date: '2026-03-05', amount: 200 });
    addTx(db, { date: '2026-03-06', amount: 45.5, status: 'PENDING' });

    const pace = computePace(db, { month: MONTH, now: NOW });
    expect(pace.data.confirmedSpend.amount).toBe(200);
    expect(pace.data.pendingSpend.amount).toBe(45.5);
    expect(pace.data.forecast.components.eligiblePending).toBe(45.5);
  });

  it('converte instante UTC para o dia civil de São Paulo', () => {
    expect(civilDate('2026-03-01T02:00:00.000Z')).toBe('2026-02-28');
    const db = makeDb();
    addTx(db, { date: '2026-03-01T02:00:00.000Z', amount: 10 });
    const marco = loadLedger(db, { from: '2026-03-01', to: '2026-04-01' });
    const fevereiro = loadLedger(db, { from: '2026-02-01', to: '2026-03-01' });
    expect(sumSpendPosted(marco.rows)).toBe(0);
    expect(sumSpendPosted(fevereiro.rows)).toBe(toMinor(10));
  });
});

describe('termômetro e projeção', () => {
  it('mês parcial compara exatamente os mesmos dias do histórico', () => {
    const db = makeDb();
    // Cada mês histórico: 100 no dia 5 (dentro da janela) e 400 no dia 25 (fora).
    seedMonthlySpend(db, HISTORY, 5, 100);
    seedMonthlySpend(db, HISTORY, 25, 400);
    addTx(db, { date: '2026-03-05', amount: 150 });

    const pace = computePace(db, { month: MONTH, now: NOW });
    expect(pace.internals.throughDay).toBe(15);
    expect(pace.counts.sampleMonths).toBe(3);
    expect(pace.data.historicalSameDaysAverage?.amount).toBe(100);
    expect(pace.data.paceRatio.value).toBe(1.5);
  });

  it('base zero não divide: ritmo null e qualidade insuficiente', () => {
    const db = makeDb();
    // Histórico existe, mas sem gasto elegível: só transferência interna.
    for (const month of HISTORY) {
      addTx(db, { date: `${month}-05`, amount: 300, categoryId: CAT_TRANSFER });
    }
    addTx(db, { date: '2026-03-05', amount: 150 });

    const pace = computePace(db, { month: MONTH, now: NOW });
    expect(pace.data.paceRatio.value).toBeNull();
    expect(pace.quality).toBe('insufficient');
    expect(pace.data.forecast.reasonCodes).toContain('NO_HISTORICAL_DISPERSION');
  });

  it('menos de 3 meses comparáveis retorna histórico insuficiente, não 0%', () => {
    const db = makeDb();
    seedMonthlySpend(db, ['2026-02'], 5, 100);
    addTx(db, { date: '2026-03-05', amount: 150 });

    const pace = computePace(db, { month: MONTH, now: NOW });
    expect(pace.counts.sampleMonths).toBe(1);
    expect(pace.quality).toBe('insufficient');
    expect(pace.data.historicalSameDaysAverage).toBeNull();
    expect(pace.data.paceRatio.value).toBeNull();
  });

  it('no último dia do mês a parcela de ritmo futuro é zero', () => {
    const db = makeDb();
    seedMonthlySpend(db, HISTORY, 5, 100);
    addTx(db, { date: '2026-03-05', amount: 150 });
    const lastDay = new Date('2026-03-31T15:00:00.000Z');

    const pace = computePace(db, { month: MONTH, now: lastDay });
    expect(pace.data.forecast.components.remainingDays).toBe(0);
    expect(pace.data.forecast.components.nonRecurringPaceFuture).toBe(0);
    expect(pace.data.forecast.amount).toBe(150);
  });

  it('projeção soma exatamente os componentes declarados', () => {
    const db = makeDb();
    seedMonthlySpend(db, HISTORY, 5, 100);
    addTx(db, { date: '2026-03-05', amount: 150 });
    addTx(db, { date: '2026-03-06', amount: 30, status: 'PENDING' });

    const pace = computePace(db, { month: MONTH, now: NOW });
    const c = pace.data.forecast.components;
    expect(c.confirmed + c.eligiblePending + c.nonRecurringPaceFuture + c.expectedRecurrencesNotYetCharged)
      .toBeCloseTo(pace.data.forecast.amount, 2);
    expect(pace.data.forecast.rangeLow).toBeLessThanOrEqual(pace.data.forecast.amount);
    expect(pace.data.forecast.rangeHigh).toBeGreaterThanOrEqual(pace.data.forecast.amount);
    // Recorrências pertencem à F3 e o motivo é declarado, não escondido.
    expect(pace.data.forecast.reasonCodes).toContain('RECURRENCES_NOT_AVAILABLE');
  });

  it('mês anterior a toda a cobertura local é métrica indisponível', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-05', amount: 150 });
    expect(() => computePace(db, { month: '2025-01', now: NOW })).toThrow(MetricNotAvailable);
    expect(() => computePace(db, { month: '2026-04', now: NOW })).toThrow(MetricNotAvailable);
  });

  it('moeda incompatível marca o período como não comparável', () => {
    const db = makeDb();
    insertAccount(db, 'acc-usd', 'BANK', 'Conta USD', 100, 'USD');
    seedMonthlySpend(db, HISTORY, 5, 100);
    addTx(db, { date: '2026-03-05', amount: 150 });
    addTx(db, { date: '2026-03-06', amount: 20, account: 'acc-usd', currency: 'USD' });

    const pace = computePace(db, { month: MONTH, now: NOW });
    expect(pace.quality).toBe('not_comparable');
  });
});

describe('rollup de categoria', () => {
  it('soma das raízes fecha com o gasto confirmado e separa Sem categoria', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-02', amount: 100, categoryId: CAT_VESTUARIO });
    addTx(db, { date: '2026-03-03', amount: 50, categoryId: CAT_COMPRAS });
    addTx(db, { date: '2026-03-04', amount: 25, categoryId: CAT_ALIMENTACAO });
    addTx(db, { date: '2026-03-05', amount: 10, categoryId: null });
    addTx(db, { date: '2026-03-06', amount: 900, categoryId: CAT_TRANSFER });

    const result = computeCategories(db, { from: '2026-03-01', to: '2026-04-01' });
    const soma = result.data.categories.reduce((acc, c) => acc + c.postedAmount, 0);
    expect(soma).toBe(185);
    expect(result.data.total.postedAmount).toBe(185);
    expect(result.data.categories.map((c) => c.rootCode)).not.toContain('04');

    const compras = result.data.categories.find((c) => c.rootCode === '08');
    expect(compras?.postedAmount).toBe(150);
    expect(compras?.children.map((c) => c.categoryId).sort()).toEqual([CAT_COMPRAS, CAT_VESTUARIO]);
    const semCategoria = result.data.categories.find((c) => c.rootCode === '00');
    expect(semCategoria?.label).toBe('Sem categoria');
    expect(semCategoria?.postedAmount).toBe(10);
  });

  it('mês parcial compara os mesmos dias do mês anterior; base zero vira nova no período', () => {
    const db = makeDb();
    addTx(db, { date: '2026-02-05', amount: 80, categoryId: CAT_COMPRAS });
    addTx(db, { date: '2026-02-25', amount: 400, categoryId: CAT_COMPRAS });
    addTx(db, { date: '2026-03-05', amount: 120, categoryId: CAT_COMPRAS });
    addTx(db, { date: '2026-03-06', amount: 60, categoryId: CAT_ALIMENTACAO });

    const result = computeCategories(db, { from: '2026-03-01', to: '2026-03-16' });
    const compras = result.data.categories.find((c) => c.rootCode === '08');
    expect(compras?.previousComparableAmount).toBe(80); // o dia 25 não entra
    expect(compras?.deltaAmount).toBe(40);
    expect(compras?.deltaPercent).toBe(50);
    expect(compras?.newInPeriod).toBe(false);

    const alimentacao = result.data.categories.find((c) => c.rootCode === '11');
    expect(alimentacao?.previousComparableAmount).toBe(0);
    expect(alimentacao?.deltaPercent).toBeNull();
    expect(alimentacao?.newInPeriod).toBe(true);
  });

  it('janela anterior de um mês cheio usa o mês anterior inteiro', () => {
    const prev = previousComparableWindow('2026-03-01', '2026-04-01');
    expect(prev.from).toBe('2026-02-01');
    expect(prev.to).toBe('2026-03-01');
    expect(prev.contains('2026-02-28')).toBe(true);
    expect(prev.contains('2026-01-31')).toBe(false);
  });

  it('includePending separa a camada provisória sem misturar com o realizado', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-02', amount: 100, categoryId: CAT_COMPRAS });
    addTx(db, { date: '2026-03-03', amount: 40, categoryId: CAT_COMPRAS, status: 'PENDING' });

    const semPending = computeCategories(db, { from: '2026-03-01', to: '2026-04-01' });
    expect(semPending.data.total.postedAmount).toBe(100);
    expect(semPending.data.total.pendingAmount).toBe(0);

    const comPending = computeCategories(db, {
      from: '2026-03-01',
      to: '2026-04-01',
      includePending: true,
    });
    expect(comPending.data.total.postedAmount).toBe(100);
    expect(comPending.data.total.pendingAmount).toBe(40);
  });
});

describe('visão geral', () => {
  it('os três contratos devolvem o mesmo gasto confirmado', () => {
    const db = makeDb();
    seedMonthlySpend(db, HISTORY, 5, 100);
    addTx(db, { date: '2026-03-02', amount: 120, categoryId: CAT_VESTUARIO });
    addTx(db, { date: '2026-03-03', amount: 45.75, categoryId: CAT_ALIMENTACAO });
    addTx(db, { date: '2026-03-04', amount: 900, categoryId: CAT_TRANSFER });
    addTx(db, { date: '2026-03-05', amount: 30, status: 'PENDING' });

    const overview = computeOverview(db, { from: '2026-03-01', to: '2026-04-01', now: NOW });
    const pace = computePace(db, { month: MONTH, now: NOW });
    const categories = computeCategories(db, { from: '2026-03-01', to: '2026-04-01' });

    expect(overview.data.monthSpend.posted).toBe(165.75);
    expect(pace.data.confirmedSpend.amount).toBe(165.75);
    expect(categories.data.total.postedAmount).toBe(165.75);
    expect(overview.data.monthSpend.pending).toBe(pace.data.pendingSpend.amount);
    expect(overview.data.forecast?.amount).toBe(pace.data.forecast.amount);
  });

  it('dia mais caro, heatmap e composição fecham com o total', () => {
    const db = makeDb();
    addSyncRun(db, '2026-03-16T07:30:00.000Z');
    addTx(db, { date: '2026-03-02', amount: 40, order: 1 });
    addTx(db, { date: '2026-03-10', amount: 90, order: 2 });
    addTx(db, { date: '2026-03-10', amount: 10, order: 3 });

    const overview = computeOverview(db, { from: '2026-03-01', to: '2026-04-01', now: NOW });
    expect(overview.data.mostExpensiveDay?.date).toBe('2026-03-10');
    expect(overview.data.mostExpensiveDay?.amount).toBe(100);
    expect(overview.data.mostExpensiveDay?.transactionRefs).toHaveLength(2);

    const somaDias = overview.data.dailySpend.reduce((acc, d) => acc + d.amount, 0);
    expect(somaDias).toBe(overview.data.monthSpend.posted);
    const somaSemana = overview.data.weekdayAverages.reduce((acc, w) => acc + w.coveredOccurrences, 0);
    expect(somaSemana).toBe(overview.data.dailySpend.length);
  });

  it('dia sem cobertura de sync é lacuna, não zero', () => {
    const db = makeDb();
    addSyncRun(db, '2026-03-10T07:30:00.000Z');
    // Patrimônio e ritmo completos: a única degradação vem da cobertura.
    seedMonthlySpend(db, HISTORY, 2, 40);
    addTx(db, { date: '2026-03-02', amount: 40 });
    addSnapshot(db, { date: '2026-02-28', bankMinor: 100_000 });
    addSnapshot(db, { date: '2026-03-09', bankMinor: 96_000 });

    const overview = computeOverview(db, { from: '2026-03-01', to: '2026-04-01', now: NOW });
    const dia2 = overview.data.dailySpend.find((d) => d.date === '2026-03-02');
    const dia12 = overview.data.dailySpend.find((d) => d.date === '2026-03-12');
    expect(dia2?.coverage).toBe('complete');
    expect(dia12?.coverage).toBe('gap');
    expect(overview.quality).toBe('partial');
  });

  it('patrimônio observável = saldos BANK − obrigação aberta do snapshot', () => {
    const db = makeDb();
    addSnapshot(db, { date: '2026-02-28', bankMinor: 900_000, billMinor: 100_000, billDueDate: '2026-03-10' });
    addSnapshot(db, { date: '2026-03-14', bankMinor: 977_065, billMinor: 132_040, billDueDate: '2026-04-10' });

    const overview = computeOverview(db, { from: '2026-03-01', to: '2026-04-01', now: NOW });
    expect(overview.data.netWorth.amount).toBe(8450.25);
    expect(overview.data.netWorth.changeAmount).toBe(450.25);
    expect(overview.data.netWorth.changePercent).toBe(5.63);
    expect(overview.data.netWorthComponents).toHaveLength(2);
    const bill = overview.data.netWorthComponents.find((c) => c.kind === 'OPEN_BILL');
    expect(bill?.amount).toBe(-1320.4);
    expect(bill?.dueDate).toBe('2026-04-10');
  });

  it('sem snapshot anterior ao período há lacuna, não série reconstruída', () => {
    const db = makeDb();
    addSnapshot(db, { date: '2026-03-14', bankMinor: 500_000, billMinor: 0, billDueDate: '2026-04-10' });

    const overview = computeOverview(db, { from: '2026-03-01', to: '2026-04-01', now: NOW });
    expect(overview.data.netWorth.amount).toBe(5000);
    expect(overview.data.netWorth.changeAmount).toBeNull();
    expect(overview.data.netWorth.changePercent).toBeNull();
    expect(overview.data.netWorth.quality).toBe('insufficient');
    expect(overview.data.netWorthSeries).toHaveLength(1);
  });

  it('sem nenhum snapshot o patrimônio é ausência, não zero', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-02', amount: 40 });
    const overview = computeOverview(db, { from: '2026-03-01', to: '2026-04-01', now: NOW });
    expect(overview.data.netWorth.amount).toBeNull();
    expect(overview.data.netWorthSeries).toHaveLength(0);
    expect(overview.quality).toBe('insufficient');
  });
});

describe('snapshots diários', () => {
  it('fatura que muda depois do dia não reescreve o snapshot anterior', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO credit_card_bills (public_id, external_id, account_public_id, due_date,
         total_amount_minor, currency_code, updated_at)
       VALUES ('bill-1','ext-bill-1',?, '2026-04-10', 100000, 'BRL', datetime('now'))`
    ).run(CARD);

    captureDailySnapshots(db, { now: new Date('2026-03-14T15:00:00.000Z') });
    db.prepare(`UPDATE credit_card_bills SET total_amount_minor = 250000 WHERE public_id='bill-1'`).run();
    captureDailySnapshots(db, { now: NOW });

    const rows = db
      .prepare(
        `SELECT snapshot_date, open_bill_amount_minor, open_bill_source, open_bill_quality
           FROM balance_snapshots WHERE account_public_id = ? ORDER BY snapshot_date`
      )
      .all(CARD) as Array<{
        snapshot_date: string;
        open_bill_amount_minor: number;
        open_bill_source: string;
        open_bill_quality: string;
      }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.open_bill_amount_minor).toBe(100_000);
    expect(rows[1]?.open_bill_amount_minor).toBe(250_000);
    expect(rows[0]?.open_bill_source).toBe('BILLS');
    expect(rows[0]?.open_bill_quality).toBe('COMPLETE');
  });

  it('sem fatura, o fallback por transações é PARTIAL e a ausência é UNAVAILABLE', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-10', amount: 250, account: CARD });
    captureDailySnapshots(db, { now: NOW });

    const card = db
      .prepare(
        `SELECT open_bill_amount_minor, open_bill_source, open_bill_quality
           FROM balance_snapshots WHERE account_public_id = ?`
      )
      .get(CARD) as { open_bill_amount_minor: number; open_bill_source: string; open_bill_quality: string };
    expect(card.open_bill_source).toBe('TRANSACTIONS_FALLBACK');
    expect(card.open_bill_quality).toBe('PARTIAL');
    expect(card.open_bill_amount_minor).toBe(25_000);

    const bank = db
      .prepare(
        `SELECT open_bill_source, open_bill_quality, closing_balance_minor
           FROM balance_snapshots WHERE account_public_id = ?`
      )
      .get(BANK) as { open_bill_source: string; open_bill_quality: string; closing_balance_minor: number };
    expect(bank.open_bill_source).toBe('UNAVAILABLE');
    expect(bank.closing_balance_minor).toBe(100_000);
  });

  it('capturar duas vezes no mesmo dia é idempotente', () => {
    const db = makeDb();
    captureDailySnapshots(db, { now: NOW });
    captureDailySnapshots(db, { now: NOW });
    const count = db.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get() as { n: number };
    expect(count.n).toBe(2); // uma linha por conta
  });
});

describe('evidências', () => {
  it('lista ordenada, paginada por cursor e sem campo sensível', () => {
    const db = makeDb();
    for (let d = 1; d <= 5; d += 1) {
      addTx(db, { date: `2026-03-0${d}`, amount: d * 10, order: d });
    }

    const first = listTransactions(db, { from: '2026-03-01', to: '2026-04-01', limit: 2 });
    expect(first.data.map((t) => t.date)).toEqual(['2026-03-05', '2026-03-04']);
    expect(first.nextCursor).not.toBeNull();
    expect(Object.keys(first.data[0] ?? {})).not.toContain('rawJsonSanitized');
    expect(first.data[0]?.version).toBeTruthy();

    const second = listTransactions(db, {
      from: '2026-03-01',
      to: '2026-04-01',
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.data.map((t) => t.date)).toEqual(['2026-03-03', '2026-03-02']);
  });

  it('filtra por raiz de categoria e por status', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-02', amount: 10, categoryId: CAT_COMPRAS });
    addTx(db, { date: '2026-03-03', amount: 20, categoryId: CAT_ALIMENTACAO });
    addTx(db, { date: '2026-03-04', amount: 30, categoryId: CAT_COMPRAS, status: 'PENDING' });

    const compras = listTransactions(db, { from: '2026-03-01', to: '2026-04-01', categoryRoot: '08' });
    expect(compras.data).toHaveLength(2);
    const posted = listTransactions(db, { from: '2026-03-01', to: '2026-04-01', status: 'POSTED' });
    expect(posted.data).toHaveLength(2);
  });
});

describe('eventos determinísticos de ritmo', () => {
  it('abre episódio acima do limiar, respeita histerese e fecha na recuperação', () => {
    const db = makeDb();
    seedMonthlySpend(db, HISTORY, 5, 100);
    const excesso = addTx(db, { date: '2026-03-05', amount: 200 }); // ritmo 2.0

    const aberto = evaluatePaceEvent(db, { now: NOW });
    expect(aberto.emitted).toBe(true);
    expect(aberto.severity).toBe('CRITICAL');

    // Repetir a avaliação não cria segundo evento ativo: acumula ocorrência.
    evaluatePaceEvent(db, { now: NOW });
    const ativos = db
      .prepare(
        `SELECT id, occurrence_count FROM outbox_events
          WHERE event_type='MONTH_PACE_HIGH' AND condition_closed_at IS NULL`
      )
      .all() as Array<{ id: string; occurrence_count: number }>;
    expect(ativos).toHaveLength(1);
    expect(ativos[0]?.occurrence_count).toBe(2);

    // Correção da classificação derruba o ritmo e fecha a condição.
    db.prepare('UPDATE transactions SET is_internal_transfer = 1 WHERE public_id = ?').run(excesso);
    const fechado = evaluatePaceEvent(db, { now: NOW });
    expect(fechado.closed).toBe(true);
  });

  it('amostra insuficiente não gera alerta', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-05', amount: 5000 });
    const result = evaluatePaceEvent(db, { now: NOW });
    expect(result.emitted).toBe(false);
    const count = db.prepare('SELECT COUNT(*) AS n FROM outbox_events').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('composição fecha com o card', () => {
  it('eligibility=SPEND soma exatamente o gasto confirmado do período', () => {
    const db = makeDb();
    addTx(db, { date: '2026-03-02', amount: 120.5, categoryId: CAT_VESTUARIO });
    addTx(db, { date: '2026-03-03', amount: 44.25, categoryId: CAT_ALIMENTACAO });
    addTx(db, { date: '2026-03-04', amount: 900, categoryId: CAT_TRANSFER });
    addTx(db, { date: '2026-03-05', amount: 33, status: 'PENDING' });
    const bankDebit = addTx(db, { date: '2026-03-06', amount: 500, categoryId: CAT_COMPRAS });
    addBillPaymentMatch(db, { bankTxId: bankDebit, amountMinor: 50_000, dueDate: '2026-03-10' });

    const overview = computeOverview(db, { from: '2026-03-01', to: '2026-04-01', now: NOW });
    const composition = listTransactions(db, {
      from: '2026-03-01',
      to: '2026-04-01',
      status: 'POSTED',
      eligibility: 'SPEND',
      limit: 100,
    });
    const soma = composition.data.reduce((acc, t) => acc + t.amount, 0);
    expect(Math.round(soma * 100) / 100).toBe(overview.data.monthSpend.posted);
    expect(composition.data.every((t) => !t.effectiveInternalTransfer)).toBe(true);
    expect(composition.data.every((t) => t.billPaymentMatch === null)).toBe(true);
  });
});
