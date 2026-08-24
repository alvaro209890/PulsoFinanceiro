/**
 * Visão geral — docs/09 §4.1 a §4.4, contrato
 * `GET /api/v1/dashboard/overview` (docs/07).
 *
 * patrimônio_observável(dia) = soma(closing_balance das contas BANK do dia)
 * − open_bill_amount do snapshot CREDIT do mesmo dia. A série vem apenas de
 * `balance_snapshots`: antes do primeiro snapshot há LACUNA, não série
 * reconstruída. Percentual só existe quando o módulo da base é maior que 0.
 *
 * Gasto, projeção e ritmo reaproveitam exatamente o mesmo razão elegível do
 * `monthly-pace`, então os dois endpoints nunca divergem em um centavo.
 */
import type { Db } from '../db/index.js';
import {
  addDays,
  civilDate,
  dayOfMonth,
  DEFAULT_TIMEZONE,
  eachDay,
  monthOf,
  monthRange,
  today as todayCivil,
  weekday,
} from './time.js';
import { fromMinor, loadLedger, sumSpendPending, sumSpendPosted, type LedgerRow } from './ledger.js';
import { worstQuality, type Quality } from './envelope.js';
import { computePace, MetricNotAvailable, type Confidence } from './pace.js';

export const OVERVIEW_METRIC_VERSION = 'dashboard-overview.v1';

export type DayCoverage = 'complete' | 'partial' | 'gap';

export interface OverviewResult {
  period: { from: string; to: string; timezone: string };
  currencyCode: string;
  counts: Record<string, number>;
  quality: Quality;
  data: OverviewData;
}

export interface OverviewData {
  netWorth: {
    amount: number | null;
    changeAmount: number | null;
    changePercent: number | null;
    currencyCode: string;
    quality: Quality;
    metricIds: Record<string, string>;
  };
  netWorthSeries: Array<{ date: string; amount: number; quality: Quality; metricId: string }>;
  netWorthComponents: Array<{
    kind: 'BANK_BALANCE' | 'OPEN_BILL';
    accountId: string;
    label: string;
    amount: number | null;
    dueDate?: string | null;
    source?: string;
    quality: Quality;
    metricIds: Record<string, string>;
  }>;
  monthSpend: {
    posted: number;
    pending: number;
    currencyCode: string;
    metricIds: Record<string, string>;
  };
  forecast: {
    amount: number;
    rangeLow: number;
    rangeHigh: number;
    currencyCode: string;
    confidence: Confidence;
    reasonCodes: string[];
    metricIds: Record<string, string>;
  } | null;
  pace: { value: number | null; metricId: string } | null;
  mostExpensiveDay: {
    date: string;
    amount: number;
    transactionRefs: string[];
    metricIds: Record<string, string>;
  } | null;
  dailySpend: Array<{ date: string; amount: number; coverage: DayCoverage; metricId: string }>;
  weekdayAverages: Array<{
    weekday: number;
    amount: number;
    coveredOccurrences: number;
    metricIds: Record<string, string>;
  }>;
  alerts: Array<{ type: string; severity: string; eventId: string; occurrenceCount: number }>;
}

export interface OverviewOptions {
  from: string;
  to: string;
  timezone?: string;
  now?: Date;
}

export function computeOverview(db: Db, options: OverviewOptions): OverviewResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? new Date();
  const { from, to } = options;
  const currentDay = todayCivil(timezone, now);

  const ledger = loadLedger(db, { from, to, timezone });
  const lastCoveredDay = lastFullyCoveredDay(db, timezone);

  // Concentração temporal
  const byDay = new Map<string, { minor: number; refs: LedgerRow[] }>();
  for (const r of ledger.rows) {
    if (!r.spendPosted) continue;
    const bucket = byDay.get(r.date) ?? { minor: 0, refs: [] };
    bucket.minor += r.amountMinor;
    bucket.refs.push(r);
    byDay.set(r.date, bucket);
  }

  const days = eachDay(from, minDate(to, addDays(currentDay, 1)));
  const dailySpend: OverviewData['dailySpend'] = days.map((date) => ({
    date,
    amount: fromMinor(byDay.get(date)?.minor ?? 0),
    coverage: coverageOf(date, lastCoveredDay, currentDay),
    metricId: `daily-spend:${date}`,
  }));

  // Dia mais caro: maior gasto; empate destaca a data mais recente e
  // conserva todos os empatados na composição.
  let mostExpensive: OverviewData['mostExpensiveDay'] = null;
  let topMinor = 0;
  for (const entry of dailySpend) {
    const minor = byDay.get(entry.date)?.minor ?? 0;
    if (minor > 0 && minor >= topMinor) {
      topMinor = minor;
      const refs = (byDay.get(entry.date)?.refs ?? [])
        .slice()
        .sort((a, b) => (b.orderTiebreak ?? 0) - (a.orderTiebreak ?? 0))
        .map((r) => r.publicId);
      mostExpensive = {
        date: entry.date,
        amount: fromMinor(minor),
        transactionRefs: refs,
        metricIds: {
          date: `most-expensive-day-date:${monthOf(from)}`,
          amount: `most-expensive-day-amount:${monthOf(from)}`,
        },
      };
    }
  }

  // Média por dia da semana sobre dias com cobertura (lacuna não vira zero).
  const weekdayTotals = new Map<number, { minor: number; occurrences: number }>();
  for (const entry of dailySpend) {
    if (entry.coverage === 'gap') continue;
    const w = weekday(entry.date);
    const acc = weekdayTotals.get(w) ?? { minor: 0, occurrences: 0 };
    acc.minor += byDay.get(entry.date)?.minor ?? 0;
    acc.occurrences += 1;
    weekdayTotals.set(w, acc);
  }
  const weekdayAverages: OverviewData['weekdayAverages'] = [];
  for (let w = 1; w <= 7; w += 1) {
    const acc = weekdayTotals.get(w);
    if (!acc || acc.occurrences === 0) continue;
    weekdayAverages.push({
      weekday: w,
      amount: fromMinor(Math.round(acc.minor / acc.occurrences)),
      coveredOccurrences: acc.occurrences,
      metricIds: {
        amount: `weekday-average:${w}:${monthOf(from)}`,
        coveredOccurrences: `weekday-covered-occurrences:${w}:${monthOf(from)}`,
      },
    });
  }

  // Projeção só existe para recorte mensal — fora disso o contrato devolve
  // null em vez de inventar um mês.
  let forecast: OverviewData['forecast'] = null;
  let pace: OverviewData['pace'] = null;
  let paceQuality: Quality = 'complete';
  if (isMonthWindow(from, to)) {
    try {
      const paceResult = computePace(db, { month: monthOf(from), timezone, now });
      forecast = {
        amount: paceResult.data.forecast.amount,
        rangeLow: paceResult.data.forecast.rangeLow,
        rangeHigh: paceResult.data.forecast.rangeHigh,
        currencyCode: paceResult.data.forecast.currencyCode,
        confidence: paceResult.data.forecast.confidence,
        reasonCodes: paceResult.data.forecast.reasonCodes,
        metricIds: paceResult.data.forecast.metricIds,
      };
      pace = paceResult.data.paceRatio;
      paceQuality = paceResult.quality;
    } catch (err) {
      if (!(err instanceof MetricNotAvailable)) throw err;
      paceQuality = 'insufficient';
    }
  }

  const netWorth = computeNetWorth(db, { from, to, timezone });

  const quality = worstQuality(
    ledger.currencies.length > 1 ? 'not_comparable' : 'complete',
    ledger.counts.cardCreditUnclassified > 0 ? 'partial' : 'complete',
    dailySpend.some((d) => d.coverage !== 'complete') ? 'partial' : 'complete',
    netWorth.quality,
    paceQuality
  );

  const alerts = db
    .prepare(
      `SELECT id, event_type, severity, occurrence_count FROM outbox_events
        WHERE condition_closed_at IS NULL AND status IN ('PENDING','LEASED')
        ORDER BY last_occurred_at DESC LIMIT 10`
    )
    .all() as Array<{ id: string; event_type: string; severity: string; occurrence_count: number }>;

  return {
    period: { from, to, timezone },
    currencyCode: ledger.currencyCode,
    counts: {
      accounts: netWorth.accounts,
      alerts: alerts.length,
      records: ledger.counts.records,
      snapshotDays: netWorth.series.length,
      cardCreditUnclassified: ledger.counts.cardCreditUnclassified,
    },
    quality,
    data: {
      netWorth: netWorth.head,
      netWorthSeries: netWorth.series,
      netWorthComponents: netWorth.components,
      monthSpend: {
        posted: fromMinor(sumSpendPosted(ledger.rows)),
        pending: fromMinor(sumSpendPending(ledger.rows)),
        currencyCode: ledger.currencyCode,
        metricIds: {
          posted: `month-spend:${monthOf(from)}`,
          pending: `month-spend-pending:${monthOf(from)}`,
        },
      },
      forecast,
      pace,
      mostExpensiveDay: mostExpensive,
      dailySpend,
      weekdayAverages,
      alerts: alerts.map((a) => ({
        type: a.event_type,
        severity: a.severity,
        eventId: a.id,
        occurrenceCount: a.occurrence_count,
      })),
    },
  };
}

interface NetWorthComputation {
  head: OverviewData['netWorth'];
  series: OverviewData['netWorthSeries'];
  components: OverviewData['netWorthComponents'];
  quality: Quality;
  accounts: number;
}

interface SnapshotRow {
  account_public_id: string;
  label: string;
  account_type: string;
  snapshot_date: string;
  closing_balance_minor: number | null;
  open_bill_amount_minor: number | null;
  open_bill_due_date: string | null;
  open_bill_source: string;
  open_bill_quality: string;
  currency_code: string;
}

function computeNetWorth(
  db: Db,
  params: { from: string; to: string; timezone: string }
): NetWorthComputation {
  const rows = db
    .prepare(
      `SELECT s.account_public_id, a.label, a.type AS account_type, s.snapshot_date,
              s.closing_balance_minor, s.open_bill_amount_minor, s.open_bill_due_date,
              s.open_bill_source, s.open_bill_quality, s.currency_code
         FROM balance_snapshots s
         JOIN accounts a ON a.public_id = s.account_public_id
        WHERE s.snapshot_date < ?
        ORDER BY s.snapshot_date ASC`
    )
    .all(params.to) as SnapshotRow[];

  const byDate = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.snapshot_date) ?? [];
    list.push(r);
    byDate.set(r.snapshot_date, list);
  }

  const series: OverviewData['netWorthSeries'] = [];
  let baseline: { date: string; minor: number } | null = null;
  let latest: { date: string; minor: number; rows: SnapshotRow[] } | null = null;

  for (const [date, dayRows] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let minor = 0;
    let dayQuality: Quality = 'complete';
    for (const r of dayRows) {
      if (r.account_type === 'CREDIT') {
        if (r.open_bill_amount_minor === null) {
          dayQuality = worstQuality(dayQuality, 'partial');
          continue;
        }
        if (r.open_bill_quality !== 'COMPLETE') dayQuality = worstQuality(dayQuality, 'partial');
        minor -= r.open_bill_amount_minor;
      } else {
        if (r.closing_balance_minor === null) {
          dayQuality = worstQuality(dayQuality, 'partial');
          continue;
        }
        minor += r.closing_balance_minor;
      }
    }
    if (date < params.from) {
      baseline = { date, minor };
      continue;
    }
    series.push({
      date,
      amount: fromMinor(minor),
      quality: dayQuality,
      metricId: `net-worth:${date}`,
    });
    latest = { date, minor, rows: dayRows };
  }

  const period = monthOf(params.from);
  const metricIds = {
    amount: latest ? `net-worth:${latest.date}` : `net-worth:${params.from}`,
    changeAmount: `net-worth-change:${period}`,
    changePercent: `net-worth-change-percent:${period}`,
  };

  if (!latest) {
    return {
      head: {
        amount: null,
        changeAmount: null,
        changePercent: null,
        currencyCode: 'BRL',
        quality: 'insufficient',
        metricIds,
      },
      series: [],
      components: [],
      quality: 'insufficient',
      accounts: 0,
    };
  }

  // Base da variação: último snapshot ANTES do período; sem ele há lacuna.
  const changeMinor = baseline ? latest.minor - baseline.minor : null;
  const changePercent =
    baseline && Math.abs(baseline.minor) > 0 && changeMinor !== null
      ? Math.round((changeMinor / Math.abs(baseline.minor)) * 10_000) / 100
      : null;

  const components: OverviewData['netWorthComponents'] = latest.rows.map((r) =>
    r.account_type === 'CREDIT'
      ? {
          kind: 'OPEN_BILL' as const,
          accountId: r.account_public_id,
          label: r.label,
          amount: r.open_bill_amount_minor === null ? null : -fromMinor(r.open_bill_amount_minor),
          dueDate: r.open_bill_due_date,
          source: r.open_bill_source,
          quality: r.open_bill_quality === 'COMPLETE' ? ('complete' as Quality) : ('partial' as Quality),
          metricIds: {
            amount: `net-worth-bill-component:${r.account_public_id}:${latest?.date ?? ''}`,
            dueDate: `bill-due:${r.account_public_id}:${r.open_bill_due_date ?? 'none'}`,
          },
        }
      : {
          kind: 'BANK_BALANCE' as const,
          accountId: r.account_public_id,
          label: r.label,
          amount: r.closing_balance_minor === null ? null : fromMinor(r.closing_balance_minor),
          quality: r.closing_balance_minor === null ? ('partial' as Quality) : ('complete' as Quality),
          metricIds: {
            amount: `net-worth-bank-component:${r.account_public_id}:${latest?.date ?? ''}`,
          },
        }
  );

  const seriesQuality = series.reduce<Quality>((acc, p) => worstQuality(acc, p.quality), 'complete');
  const headQuality = baseline ? seriesQuality : worstQuality(seriesQuality, 'insufficient');

  return {
    head: {
      amount: fromMinor(latest.minor),
      changeAmount: changeMinor === null ? null : fromMinor(changeMinor),
      changePercent,
      currencyCode: latest.rows[0]?.currency_code ?? 'BRL',
      quality: headQuality,
      metricIds,
    },
    series,
    components,
    quality: headQuality,
    accounts: latest.rows.length,
  };
}

/**
 * Cobertura do dia: `complete` quando existe harvest bem-sucedido depois do
 * fim daquele dia; `partial` no dia ainda em andamento; `gap` quando nada
 * garante que o dia foi lido — lacuna nunca é pintada como zero.
 */
export function coverageOf(date: string, lastCoveredDay: string | null, currentDay: string): DayCoverage {
  if (lastCoveredDay === null) return 'gap';
  if (date < lastCoveredDay) return 'complete';
  if (date === lastCoveredDay || date === currentDay) return 'partial';
  return 'gap';
}

/** Data civil do último harvest bem-sucedido. */
export function lastFullyCoveredDay(db: Db, timezone: string = DEFAULT_TIMEZONE): string | null {
  const row = db
    .prepare('SELECT MAX(finished_at) AS f FROM sync_runs WHERE ok = 1')
    .get() as { f: string | null } | undefined;
  if (!row?.f) return null;
  return civilDate(row.f, timezone);
}

function isMonthWindow(from: string, to: string): boolean {
  if (dayOfMonth(from) !== 1) return false;
  const { to: monthEnd } = monthRange(monthOf(from));
  return to <= monthEnd;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}
