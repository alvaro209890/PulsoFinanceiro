/**
 * Termômetro do mês e projeção de fechamento — docs/09 §4.2 e §4.3,
 * contrato `GET /api/v1/analytics/monthly-pace` (docs/07).
 *
 * ritmo = gasto_confirmado_do_dia_1_ao_d / média(gasto confirmado dos dias
 * 1..d nos N meses anteriores). Mês parcial compara SEMPRE os mesmos dias
 * decorridos. Média menor ou igual a zero devolve `null`, nunca infinito
 * nem 0% inventado.
 *
 * projeção = confirmado + pendências elegíveis + ritmo_não_recorrente ×
 * dias_restantes + recorrentes previstas ainda não cobradas. Recorrências
 * pertencem à F3: nesta fase a parcela é 0 e o motivo é declarado em
 * `reasonCodes`, em vez de ser silenciosamente somada ao ritmo.
 */
import type { Db } from '../db/index.js';
import {
  addMonths,
  civilDate,
  dayOfMonth,
  daysInMonth,
  DEFAULT_TIMEZONE,
  monthOf,
  monthRange,
  today as todayCivil,
} from './time.js';
import { fromMinor, loadLedger, sumSpendPending, sumSpendPosted, type LedgerRow } from './ledger.js';
import { worstQuality, type Quality } from './envelope.js';

export const PACE_METRIC_VERSION = 'monthly-pace.v1';

export const DEFAULT_COMPARISON_MONTHS = 6;
export const MIN_COMPARISON_SAMPLE = 3;
/** Dispersão usada quando não há amostra histórica suficiente (docs/09 §4.3). */
export const DEFAULT_DISPERSION_LOW = 0.85;
export const DEFAULT_DISPERSION_HIGH = 1.15;

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface MoneyMetric {
  amount: number;
  currencyCode: string;
  metricId: string;
}

export interface PaceData {
  confirmedSpend: MoneyMetric;
  pendingSpend: MoneyMetric;
  historicalSameDaysAverage: MoneyMetric | null;
  historicalSameDaysMin: MoneyMetric | null;
  historicalSameDaysMax: MoneyMetric | null;
  paceRatio: { value: number | null; metricId: string };
  forecast: {
    amount: number;
    rangeLow: number;
    rangeHigh: number;
    currencyCode: string;
    confidence: Confidence;
    reasonCodes: string[];
    components: {
      confirmed: number;
      eligiblePending: number;
      nonRecurringPaceFuture: number;
      expectedRecurrencesNotYetCharged: number;
      remainingDays: number;
    };
    metricIds: Record<string, string>;
  };
  daily: Array<{
    date: string;
    confirmed: number;
    historicalAverage: number | null;
    metricIds: Record<string, string>;
  }>;
  expectedRecurrences: never[];
}

export interface PaceResult {
  period: { from: string; to: string; timezone: string };
  currencyCode: string;
  counts: Record<string, number>;
  quality: Quality;
  data: PaceData;
  /** interno, reaproveitado pela Visão geral — não vai para a borda */
  internals: {
    month: string;
    throughDay: number;
    remainingDays: number;
    confirmedMinor: number;
    pendingMinor: number;
    forecastMinor: number;
    rangeLowMinor: number;
    rangeHighMinor: number;
    paceRatio: number | null;
    sampleMonths: number;
    cardCreditUnclassified: number;
    rows: LedgerRow[];
  };
}

/** Erro de amostra/cobertura → 422 METRIC_NOT_AVAILABLE na borda. */
export class MetricNotAvailable extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'MetricNotAvailable';
  }
}

export interface PaceOptions {
  month: string;
  comparisonMonths?: number;
  timezone?: string;
  now?: Date;
}

export function computePace(db: Db, options: PaceOptions): PaceResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const comparisonMonths = options.comparisonMonths ?? DEFAULT_COMPARISON_MONTHS;
  const month = options.month;
  const now = options.now ?? new Date();
  const currentDay = todayCivil(timezone, now);
  const currentMonth = monthOf(currentDay);

  if (month > currentMonth) {
    throw new MetricNotAvailable('MONTH_IN_FUTURE');
  }

  const range = monthRange(month);
  const totalDays = daysInMonth(month);
  // Mês corrente vai do dia 1 até hoje; mês encerrado usa o mês inteiro.
  const throughDay = month === currentMonth ? dayOfMonth(currentDay) : totalDays;
  const remainingDays = totalDays - throughDay;

  const earliest = earliestCoveredMonth(db, timezone);
  if (earliest === null || month < earliest) {
    throw new MetricNotAvailable('MONTH_BEFORE_COVERAGE');
  }

  const firstComparison = addMonths(month, -comparisonMonths);
  const ledger = loadLedger(db, {
    from: monthRange(firstComparison).from,
    to: range.to,
    timezone,
  });

  const currentRows = ledger.rows.filter((r) => monthOf(r.date) === month);
  const comparableCurrent = currentRows.filter((r) => dayOfMonth(r.date) <= throughDay);
  const confirmedMinor = sumSpendPosted(comparableCurrent);
  const pendingMinor = sumSpendPending(comparableCurrent);

  // Amostra histórica: apenas meses dentro da cobertura local, sempre
  // recortados nos mesmos dias decorridos do mês corrente.
  const sample: Array<{ month: string; totalMinor: number; byDay: Map<number, number> }> = [];
  for (let i = 1; i <= comparisonMonths; i += 1) {
    const m = addMonths(month, -i);
    if (m < earliest) continue;
    const rows = ledger.rows.filter((r) => monthOf(r.date) === m && dayOfMonth(r.date) <= throughDay);
    const byDay = new Map<number, number>();
    for (const r of rows) {
      if (!r.spendPosted) continue;
      const d = dayOfMonth(r.date);
      byDay.set(d, (byDay.get(d) ?? 0) + r.amountMinor);
    }
    sample.push({ month: m, totalMinor: sumSpendPosted(rows), byDay });
  }

  const sampleMonths = sample.length;
  const hasSample = sampleMonths >= MIN_COMPARISON_SAMPLE;
  const totals = sample.map((s) => s.totalMinor);
  const averageMinor =
    totals.length > 0 ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0;
  const minMinor = totals.length > 0 ? Math.min(...totals) : 0;
  const maxMinor = totals.length > 0 ? Math.max(...totals) : 0;

  // Denominador <= 0 nunca vira divisão: ritmo fica null e a qualidade cai.
  const denominatorUsable = hasSample && averageMinor > 0;
  const paceRatio = denominatorUsable ? round4(confirmedMinor / averageMinor) : null;

  const paceFutureMinor =
    throughDay > 0 && remainingDays > 0 ? Math.round((confirmedMinor / throughDay) * remainingDays) : 0;
  const expectedRecurrencesMinor = 0; // F3 entrega recorrências
  const forecastMinor = confirmedMinor + pendingMinor + paceFutureMinor + expectedRecurrencesMinor;

  const lowRatio = denominatorUsable ? minMinor / averageMinor : DEFAULT_DISPERSION_LOW;
  const highRatio = denominatorUsable ? maxMinor / averageMinor : DEFAULT_DISPERSION_HIGH;
  const base = confirmedMinor + pendingMinor;
  const rangeLowMinor = Math.min(forecastMinor, base + Math.round(paceFutureMinor * lowRatio));
  const rangeHighMinor = Math.max(forecastMinor, base + Math.round(paceFutureMinor * highRatio));

  const reasonCodes: string[] = ['RECURRENCES_NOT_AVAILABLE'];
  if (throughDay < 14) reasonCodes.push('SHORT_CURRENT_MONTH_COVERAGE');
  if (!hasSample) reasonCodes.push('INSUFFICIENT_HISTORY');
  if (!denominatorUsable) reasonCodes.push('NO_HISTORICAL_DISPERSION');
  if (ledger.counts.cardCreditUnclassified > 0) reasonCodes.push('CARD_CREDIT_UNCLASSIFIED');

  const confidence: Confidence =
    !hasSample || throughDay < 7 ? 'LOW' : throughDay >= 14 ? 'HIGH' : 'MEDIUM';

  const dailyConfirmed = new Map<number, number>();
  for (const r of comparableCurrent) {
    if (!r.spendPosted) continue;
    const d = dayOfMonth(r.date);
    dailyConfirmed.set(d, (dailyConfirmed.get(d) ?? 0) + r.amountMinor);
  }
  const daily: PaceData['daily'] = [];
  for (let d = 1; d <= throughDay; d += 1) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const historicalMonths = sample.filter((s) => d <= daysInMonth(s.month));
    const historicalAverage =
      historicalMonths.length > 0
        ? fromMinor(
            Math.round(
              historicalMonths.reduce((acc, s) => acc + (s.byDay.get(d) ?? 0), 0) /
                historicalMonths.length
            )
          )
        : null;
    daily.push({
      date,
      confirmed: fromMinor(dailyConfirmed.get(d) ?? 0),
      historicalAverage,
      metricIds: {
        confirmed: `daily-confirmed:${date}`,
        historicalAverage: `daily-historical-average:${date}:${comparisonMonths}`,
      },
    });
  }

  // Denominador inutilizável (amostra curta ou média <= 0) é insuficiência
  // declarada, não um ritmo "completo" com valor nulo (docs/09 §4.2).
  const quality = worstQuality(
    ledger.currencies.length > 1 ? 'not_comparable' : 'complete',
    ledger.counts.cardCreditUnclassified > 0 ? 'partial' : 'complete',
    denominatorUsable ? 'complete' : 'insufficient'
  );

  const currencyCode = ledger.currencyCode;
  const money = (minor: number, metricId: string): MoneyMetric => ({
    amount: fromMinor(minor),
    currencyCode,
    metricId,
  });

  const data: PaceData = {
    confirmedSpend: money(confirmedMinor, `month-spend:${month}`),
    pendingSpend: money(pendingMinor, `month-spend-pending:${month}`),
    historicalSameDaysAverage: hasSample
      ? money(averageMinor, `same-days-average:${month}:${comparisonMonths}`)
      : null,
    historicalSameDaysMin: hasSample
      ? money(minMinor, `same-days-min:${month}:${comparisonMonths}`)
      : null,
    historicalSameDaysMax: hasSample
      ? money(maxMinor, `same-days-max:${month}:${comparisonMonths}`)
      : null,
    paceRatio: { value: paceRatio, metricId: `month-pace-ratio:${month}:${comparisonMonths}` },
    forecast: {
      amount: fromMinor(forecastMinor),
      rangeLow: fromMinor(rangeLowMinor),
      rangeHigh: fromMinor(rangeHighMinor),
      currencyCode,
      confidence,
      reasonCodes,
      components: {
        confirmed: fromMinor(confirmedMinor),
        eligiblePending: fromMinor(pendingMinor),
        nonRecurringPaceFuture: fromMinor(paceFutureMinor),
        expectedRecurrencesNotYetCharged: fromMinor(expectedRecurrencesMinor),
        remainingDays,
      },
      metricIds: {
        amount: `month-forecast:${month}`,
        rangeLow: `month-forecast-low:${month}`,
        rangeHigh: `month-forecast-high:${month}`,
        confirmed: `month-forecast-confirmed:${month}`,
        eligiblePending: `month-forecast-pending:${month}`,
        nonRecurringPaceFuture: `month-forecast-pace-future:${month}`,
        expectedRecurrencesNotYetCharged: `month-forecast-recurrences:${month}`,
        remainingDays: `month-forecast-remaining-days:${month}`,
      },
    },
    daily,
    expectedRecurrences: [],
  };

  return {
    period: { from: range.from, to: range.to, timezone },
    currencyCode,
    counts: {
      sampleMonths,
      dailyPoints: daily.length,
      expectedRecurrences: 0,
      cardCreditUnclassified: ledger.counts.cardCreditUnclassified,
      records: currentRows.length,
    },
    quality,
    data,
    internals: {
      month,
      throughDay,
      remainingDays,
      confirmedMinor,
      pendingMinor,
      forecastMinor,
      rangeLowMinor,
      rangeHighMinor,
      paceRatio,
      sampleMonths,
      cardCreditUnclassified: ledger.counts.cardCreditUnclassified,
      rows: currentRows,
    },
  };
}

/** Primeiro mês com cobertura local de transação, em data civil. */
export function earliestCoveredMonth(db: Db, timezone: string = DEFAULT_TIMEZONE): string | null {
  const row = db.prepare('SELECT MIN(date) AS d FROM transactions').get() as
    | { d: string | null }
    | undefined;
  if (!row?.d) return null;
  return monthOf(civilDate(row.d, timezone));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
