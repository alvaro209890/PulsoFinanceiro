/**
 * Recorrências — docs/09 §6.1 a §6.4 e contrato
 * `GET /api/v1/analytics/recurrences` (docs/07).
 *
 * A chave é `merchant.cnpj` normalizado quando existe; senão, a descrição
 * normalizada (`DESC_NORM_V1`). Documento do pagador NUNCA participa da
 * chave.
 *
 * É recorrente quando há ao menos 3 ocorrências, `regularidade >= 0,67`,
 * `estabilidade >= 0,70` e a última ocorrência não está atrasada mais que
 * 1,5 cadência. Mediana <= 0 deixa a estabilidade nula e a série fora.
 *
 * O produto NÃO afirma "assinatura sem uso": a fonte bancária não tem
 * telemetria de uso. O que existe é **cobrança retomada após inatividade
 * de cobrança** (`RESUMED`), que prova apenas reaparecimento no extrato.
 */
import type { Db } from '../db/index.js';
import { ulid } from 'ulid';
import { civilDate, daysBetween, DEFAULT_TIMEZONE, today as todayCivil } from './time.js';
import { fromMinor, INTERNAL_TRANSFER_ROOT, toMinor } from './ledger.js';
import { normalizeCnpj, normalizeDescription } from './normalize.js';
import { worstQuality, type Quality } from './envelope.js';

export const RECURRENCES_METRIC_VERSION = 'recurrences.v1';
export const RECURRENCE_ANALYSIS_VERSION = 'recurrence.v1';

export const MIN_OCCURRENCES = 3;
export const MIN_REGULARITY = 0.67;
export const MIN_STABILITY = 0.7;
/** Atraso tolerado antes de a série deixar de ser corrente. */
export const OVERDUE_CADENCE_FACTOR = 1.5;
/** Atraso que caracteriza inatividade de cobrança. */
export const DORMANT_CADENCE_FACTOR = 2;
/** Hiato máximo que ainda conta como retomada (docs/09 §6.3). */
export const MAX_RESUMED_GAP_DAYS = 365;

export type Cadence = 'WEEKLY' | 'MONTHLY' | 'BIMONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type RecurrenceStatus = 'ACTIVE' | 'DORMANT' | 'RESUMED';

interface CadenceBand {
  cadence: Cadence;
  min: number;
  max: number;
  annualMultiplier: number;
}

/** Faixas fechadas de docs/09 §6.1 e multiplicadores de §6.4. */
export const CADENCE_BANDS: readonly CadenceBand[] = [
  { cadence: 'WEEKLY', min: 5, max: 9, annualMultiplier: 52 },
  { cadence: 'MONTHLY', min: 25, max: 35, annualMultiplier: 12 },
  { cadence: 'BIMONTHLY', min: 50, max: 70, annualMultiplier: 6 },
  { cadence: 'QUARTERLY', min: 75, max: 105, annualMultiplier: 4 },
  { cadence: 'ANNUAL', min: 330, max: 400, annualMultiplier: 1 },
];

export function bandFor(intervalDays: number): CadenceBand | null {
  return CADENCE_BANDS.find((b) => intervalDays >= b.min && intervalDays <= b.max) ?? null;
}

export function annualMultiplier(cadence: Cadence): number {
  return CADENCE_BANDS.find((b) => b.cadence === cadence)?.annualMultiplier ?? 0;
}

export interface AnalyzeResult {
  seriesConsidered: number;
  seriesPersisted: number;
  /** Séries que deixaram de qualificar e saíram do estado. */
  seriesRemoved: number;
  statuses: Record<RecurrenceStatus, number>;
  priceIncreases: number;
}

interface Occurrence {
  publicId: string;
  date: string;
  amountMinor: number;
  categoryId: string | null;
  currency: string;
}

interface Series {
  matcherType: 'MERCHANT_CNPJ' | 'DESCRIPTION_RAW_NORMALIZED';
  matcherValue: string;
  displayName: string;
  occurrences: Occurrence[];
}

/**
 * Recalcula e persiste as séries. Chamado no fim do harvest, no mesmo ponto
 * em que a métrica é confirmada.
 */
export function analyzeRecurrences(
  db: Db,
  options: { now?: Date; timezone?: string } = {}
): AnalyzeResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? new Date();
  const currentDay = todayCivil(timezone, now);
  const analyzedAt = now.toISOString();

  const rows = db
    .prepare(
      `SELECT t.public_id, t.date, t.amount, t.currency, t.category_id, t.merchant_cnpj,
              t.merchant_business_name, t.description_raw_normalized, t.description,
              t.is_internal_transfer, m.role AS bill_role
         FROM transactions t
         LEFT JOIN transaction_bill_payment_matches m ON m.transaction_public_id = t.public_id
        WHERE t.status = 'POSTED' AND t.type = 'DEBIT'
        ORDER BY t.date ASC`
    )
    .all() as Array<{
      public_id: string;
      date: string;
      amount: number;
      currency: string;
      category_id: string | null;
      merchant_cnpj: string | null;
      merchant_business_name: string | null;
      description_raw_normalized: string | null;
      description: string | null;
      is_internal_transfer: number;
      bill_role: string | null;
    }>;

  const seriesByKey = new Map<string, Series>();
  for (const r of rows) {
    // Fora: transferência interna, pagamento de fatura, encargo financeiro e
    // aplicação em investimento — a tela fala de CUSTO anualizado, e dinheiro
    // que sai para render não é custo (raiz 03 da taxonomia Pluggy).
    const rootCode = r.category_id ? r.category_id.slice(0, 2) : '00';
    if (r.is_internal_transfer === 1 || rootCode === INTERNAL_TRANSFER_ROOT) continue;
    if (rootCode === INVESTMENT_ROOT) continue;
    if (r.bill_role !== null) continue;
    if (FINANCE_CHARGE_CATEGORIES.has(r.category_id ?? '')) continue;

    const cnpj = normalizeCnpj(r.merchant_cnpj);
    const normalized = r.description_raw_normalized ?? normalizeDescription(r.description);
    const matcherType = cnpj ? 'MERCHANT_CNPJ' : 'DESCRIPTION_RAW_NORMALIZED';
    const matcherValue = cnpj ?? normalized;
    if (!matcherValue) continue;

    const key = `${matcherType}:${matcherValue}`;
    const series = seriesByKey.get(key) ?? {
      matcherType,
      matcherValue,
      displayName: r.merchant_business_name ?? normalized ?? matcherValue,
      occurrences: [],
    };
    series.occurrences.push({
      publicId: r.public_id,
      date: civilDate(r.date, timezone),
      amountMinor: toMinor(r.amount),
      categoryId: r.category_id,
      currency: r.currency,
    });
    seriesByKey.set(key, series);
  }

  const result: AnalyzeResult = {
    seriesConsidered: seriesByKey.size,
    seriesPersisted: 0,
    seriesRemoved: 0,
    statuses: { ACTIVE: 0, DORMANT: 0, RESUMED: 0 },
    priceIncreases: 0,
  };

  const persistedIds: string[] = [];

  const run = db.transaction(() => {
    for (const series of seriesByKey.values()) {
      const evaluated = evaluateSeries(series, currentDay);
      if (!evaluated) continue;

      const existing = db
        .prepare('SELECT id, status, resumed_at FROM recurring_analysis WHERE matcher_type=? AND matcher_value=?')
        .get(series.matcherType, series.matcherValue) as
        | { id: string; status: string; resumed_at: string | null }
        | undefined;
      const id = existing?.id ?? ulid();

      // `resumed_at` marca o instante em que a retomada foi observada e não
      // é reescrito enquanto o episódio continuar aberto.
      const resumedAt =
        evaluated.status === 'RESUMED'
          ? existing?.status === 'RESUMED' && existing.resumed_at
            ? existing.resumed_at
            : analyzedAt
          : null;

      db.prepare(
        `INSERT INTO recurring_analysis
           (id, matcher_type, matcher_value, display_name, cadence, median_interval_days,
            median_amount_minor, annualized_cost_minor, next_expected_date, last_occurrence_date,
            category_id, currency_code, status, regularity_score, amount_stability_score,
            last_gap_days, resumed_at, analysis_version, active, price_increase_detected,
            price_base_minor, price_current_minor, price_window_size, confidence, analyzed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(matcher_type, matcher_value) DO UPDATE SET
           display_name=excluded.display_name, cadence=excluded.cadence,
           median_interval_days=excluded.median_interval_days,
           median_amount_minor=excluded.median_amount_minor,
           annualized_cost_minor=excluded.annualized_cost_minor,
           next_expected_date=excluded.next_expected_date,
           last_occurrence_date=excluded.last_occurrence_date,
           category_id=excluded.category_id, currency_code=excluded.currency_code,
           status=excluded.status, regularity_score=excluded.regularity_score,
           amount_stability_score=excluded.amount_stability_score,
           last_gap_days=excluded.last_gap_days, resumed_at=excluded.resumed_at,
           analysis_version=excluded.analysis_version, active=excluded.active,
           price_increase_detected=excluded.price_increase_detected,
           price_base_minor=excluded.price_base_minor,
           price_current_minor=excluded.price_current_minor,
           price_window_size=excluded.price_window_size,
           confidence=excluded.confidence, analyzed_at=excluded.analyzed_at`
      ).run(
        id,
        series.matcherType,
        series.matcherValue,
        series.displayName.slice(0, 120),
        evaluated.cadence,
        evaluated.medianIntervalDays,
        evaluated.medianAmountMinor,
        evaluated.annualizedMinor,
        evaluated.nextExpectedDate,
        evaluated.lastOccurrenceDate,
        evaluated.categoryId,
        evaluated.currency,
        evaluated.status,
        Math.round(evaluated.regularity * 10_000),
        Math.round(evaluated.stability * 10_000),
        evaluated.lastGapDays,
        resumedAt,
        RECURRENCE_ANALYSIS_VERSION,
        evaluated.status === 'DORMANT' ? 0 : 1,
        evaluated.priceIncrease ? 1 : 0,
        evaluated.priceIncrease?.baseMinor ?? null,
        evaluated.priceIncrease?.currentMinor ?? null,
        evaluated.priceIncrease?.windowSize ?? null,
        evaluated.confidence,
        analyzedAt
      );

      db.prepare('DELETE FROM recurring_occurrences WHERE recurring_id = ?').run(id);
      for (const occ of series.occurrences) {
        db.prepare(
          `INSERT INTO recurring_occurrences (recurring_id, transaction_public_id, matched_at)
           VALUES (?,?,?)`
        ).run(id, occ.publicId, analyzedAt);
      }

      persistedIds.push(id);
      result.seriesPersisted += 1;
      result.statuses[evaluated.status] += 1;
      if (evaluated.priceIncrease) result.priceIncreases += 1;
    }

    // Série que deixou de qualificar (ficou curta, virou irregular ou passou
    // a ser excluída) some do estado: manter a linha velha seria alegar um
    // padrão que a análise atual não sustenta.
    const stale = db
      .prepare('SELECT id FROM recurring_analysis WHERE analysis_version = ?')
      .all(RECURRENCE_ANALYSIS_VERSION) as Array<{ id: string }>;
    const keep = new Set(persistedIds);
    for (const row of stale) {
      if (!keep.has(row.id)) {
        db.prepare('DELETE FROM recurring_analysis WHERE id = ?').run(row.id);
        result.seriesRemoved += 1;
      }
    }
  });
  run();

  return result;
}

/** IOF e juros: encargo financeiro não é recorrência de consumo. */
const FINANCE_CHARGE_CATEGORIES = new Set(['15030000', '02020000']);

/** Raiz de investimentos: aplicação recorrente não é despesa recorrente. */
const INVESTMENT_ROOT = '03';

export interface EvaluatedSeries {
  cadence: Cadence;
  medianIntervalDays: number;
  medianAmountMinor: number;
  annualizedMinor: number;
  nextExpectedDate: string;
  lastOccurrenceDate: string;
  categoryId: string | null;
  currency: string;
  status: RecurrenceStatus;
  regularity: number;
  stability: number;
  lastGapDays: number | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  priceIncrease: { baseMinor: number; currentMinor: number; windowSize: number } | null;
}

/** Classificação determinística de uma série; `null` = não é recorrência. */
export function evaluateSeries(series: Series, currentDay: string): EvaluatedSeries | null {
  const occurrences = [...series.occurrences].sort((a, b) => a.date.localeCompare(b.date));
  if (occurrences.length < MIN_OCCURRENCES) return null;

  const currencies = new Set(occurrences.map((o) => o.currency));
  if (currencies.size > 1) return null; // moedas não se misturam (docs/09 §6.4)

  const intervals: number[] = [];
  for (let i = 1; i < occurrences.length; i += 1) {
    intervals.push(daysBetween(occurrences[i - 1]!.date, occurrences[i]!.date));
  }
  const medianIntervalDays = Math.round(median(intervals));
  const band = bandFor(medianIntervalDays);
  if (!band) return null; // sem cadência classificada não entra no total

  const regularity = intervals.filter((d) => d >= band.min && d <= band.max).length / intervals.length;
  const amounts = occurrences.map((o) => o.amountMinor);
  const medianAmountMinor = Math.round(median(amounts));
  if (medianAmountMinor <= 0) return null; // denominador inválido → série fora

  const stability = 1 - Math.min(medianAbsoluteDeviation(amounts) / medianAmountMinor, 1);
  if (regularity < MIN_REGULARITY || stability < MIN_STABILITY) return null;

  const last = occurrences[occurrences.length - 1]!;
  const daysSinceLast = daysBetween(last.date, currentDay);
  const lastGapDays = intervals.length > 0 ? intervals[intervals.length - 1]! : null;

  let status: RecurrenceStatus = 'ACTIVE';
  if (daysSinceLast > medianIntervalDays * DORMANT_CADENCE_FACTOR) {
    status = 'DORMANT';
  } else if (
    lastGapDays !== null &&
    lastGapDays >= medianIntervalDays * DORMANT_CADENCE_FACTOR &&
    lastGapDays < MAX_RESUMED_GAP_DAYS
  ) {
    status = 'RESUMED';
  } else if (daysSinceLast > medianIntervalDays * OVERDUE_CADENCE_FACTOR) {
    // Atrasada mas ainda não inativa: não é corrente, e também não é
    // dormência provada. Fica ativa com confiança menor.
    status = 'ACTIVE';
  }

  const priceIncrease = detectPriceIncrease(amounts);

  const confidence: 'LOW' | 'MEDIUM' | 'HIGH' =
    occurrences.length >= 6 && regularity >= 0.8 && stability >= 0.85
      ? 'HIGH'
      : occurrences.length >= 4 && regularity >= 0.7
        ? 'MEDIUM'
        : 'LOW';

  return {
    cadence: band.cadence,
    medianIntervalDays,
    medianAmountMinor,
    annualizedMinor: medianAmountMinor * band.annualMultiplier,
    nextExpectedDate: addDaysCivil(last.date, medianIntervalDays),
    lastOccurrenceDate: last.date,
    categoryId: last.categoryId,
    currency: last.currency,
    status,
    regularity,
    stability,
    lastGapDays,
    confidence,
    priceIncrease,
  };
}

/**
 * Reajuste (docs/09 §6.2): `base` é a mediana dos últimos 3 a 6 valores
 * ANTERIORES; `limiar = max(10%, 2 × MAD/base)`; há reajuste quando o valor
 * atual passa de `base × (1 + limiar)`. A cópia diz "subiu fora do padrão",
 * nunca "mudou de contrato".
 */
export function detectPriceIncrease(
  amounts: readonly number[]
): { baseMinor: number; currentMinor: number; windowSize: number } | null {
  if (amounts.length < 4) return null;
  const current = amounts[amounts.length - 1]!;
  const previous = amounts.slice(Math.max(0, amounts.length - 7), amounts.length - 1);
  if (previous.length < 3) return null;
  const window = previous.slice(-6);
  const base = median(window);
  if (base <= 0) return null;
  const threshold = Math.max(0.1, (2 * medianAbsoluteDeviation(window)) / base);
  if (current <= base * (1 + threshold)) return null;
  return { baseMinor: Math.round(base), currentMinor: current, windowSize: window.length };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function medianAbsoluteDeviation(values: readonly number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

function addDaysCivil(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Leitura para a API
// ---------------------------------------------------------------------------

export interface RecurrencesResult {
  period: { from: string; to: string; timezone: string };
  currencyCode: string;
  counts: Record<string, number>;
  quality: Quality;
  data: {
    annualizedTotal: { amount: number; currencyCode: string; metricId: string };
    annualizedByCategory: Array<{
      categoryId: string | null;
      label: string | null;
      amount: number;
      currencyCode: string;
      metricId: string;
    }>;
    recurrences: RecurrenceDto[];
  };
}

export interface RecurrenceDto {
  id: string;
  displayName: string;
  status: RecurrenceStatus;
  cadence: Cadence;
  typicalAmount: number;
  nextExpectedDate: string | null;
  lastOccurrenceDate: string | null;
  annualizedCost: number;
  regularityScore: number;
  amountStabilityScore: number;
  lastGapDays: number | null;
  resumedAt: string | null;
  analysisVersion: string;
  confidence: string;
  categoryId: string | null;
  priceIncrease: {
    detected: boolean;
    baseAmount: number | null;
    currentAmount: number | null;
    increaseAmount: number | null;
    increasePercent: number | null;
    windowSize: number | null;
    metricIds: Record<string, string>;
  };
  evidence: { occurrenceCount: number; transactionRefs: string[]; coverageComplete: boolean };
  metricIds: Record<string, string>;
}

export function listRecurrences(
  db: Db,
  options: { status?: RecurrenceStatus | 'ALL'; limit?: number; timezone?: string; now?: Date } = {}
): RecurrencesResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const now = options.now ?? new Date();
  const currentDay = todayCivil(timezone, now);
  const status = options.status ?? 'ALL';
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const rows = db
    .prepare(
      `SELECT * FROM recurring_analysis
        ${status === 'ALL' ? '' : 'WHERE status = ?'}
        ORDER BY annualized_cost_minor DESC, id ASC
        LIMIT ?`
    )
    .all(...(status === 'ALL' ? [limit] : [status, limit])) as Array<Record<string, unknown>>;

  const labels = new Map(
    (
      db.prepare('SELECT id, description_translated FROM categories').all() as Array<{
        id: string;
        description_translated: string;
      }>
    ).map((c) => [c.id, c.description_translated])
  );

  const occurrenceStmt = db.prepare(
    'SELECT transaction_public_id FROM recurring_occurrences WHERE recurring_id = ? ORDER BY transaction_public_id'
  );

  const recurrences: RecurrenceDto[] = rows.map((r) => {
    const id = String(r['id']);
    const refs = (occurrenceStmt.all(id) as Array<{ transaction_public_id: string }>).map(
      (o) => o.transaction_public_id
    );
    const baseMinor = r['price_base_minor'] as number | null;
    const currentMinor = r['price_current_minor'] as number | null;
    const detected = r['price_increase_detected'] === 1;
    const increaseMinor = detected && baseMinor !== null && currentMinor !== null ? currentMinor - baseMinor : null;

    return {
      id,
      displayName: String(r['display_name']),
      status: r['status'] as RecurrenceStatus,
      cadence: r['cadence'] as Cadence,
      typicalAmount: fromMinor(Number(r['median_amount_minor'] ?? 0)),
      nextExpectedDate: (r['next_expected_date'] as string | null) ?? null,
      lastOccurrenceDate: (r['last_occurrence_date'] as string | null) ?? null,
      annualizedCost: fromMinor(Number(r['annualized_cost_minor'] ?? 0)),
      regularityScore: Number(r['regularity_score']) / 10_000,
      amountStabilityScore: Number(r['amount_stability_score']) / 10_000,
      lastGapDays: (r['last_gap_days'] as number | null) ?? null,
      resumedAt: (r['resumed_at'] as string | null) ?? null,
      analysisVersion: String(r['analysis_version']),
      confidence: String(r['confidence']),
      categoryId: (r['category_id'] as string | null) ?? null,
      priceIncrease: {
        detected,
        baseAmount: baseMinor === null ? null : fromMinor(baseMinor),
        currentAmount: currentMinor === null ? null : fromMinor(currentMinor),
        increaseAmount: increaseMinor === null ? null : fromMinor(increaseMinor),
        increasePercent:
          increaseMinor === null || baseMinor === null || baseMinor <= 0
            ? null
            : Math.round((increaseMinor / baseMinor) * 1_000_000) / 10_000,
        windowSize: (r['price_window_size'] as number | null) ?? null,
        metricIds: {
          baseAmount: `recurrence-price-base:${id}`,
          currentAmount: `recurrence-price-current:${id}`,
          increaseAmount: `recurrence-price-delta:${id}`,
          increasePercent: `recurrence-price-percent:${id}`,
        },
      },
      evidence: {
        occurrenceCount: refs.length,
        transactionRefs: refs,
        coverageComplete: r['status'] !== 'DORMANT',
      },
      metricIds: {
        typicalAmount: `recurrence-typical:${id}`,
        nextExpectedDate: `recurrence-next-date:${id}`,
        lastOccurrenceDate: `recurrence-last-date:${id}`,
        annualizedCost: `recurrence-annualized:${id}`,
        regularityScore: `recurrence-regularity:${id}`,
        amountStabilityScore: `recurrence-stability:${id}`,
        lastGapDays: `recurrence-gap-days:${id}`,
      },
    };
  });

  const active = recurrences.filter((r) => r.status !== 'DORMANT');
  const currencies = new Set(rows.map((r) => String(r['currency_code'] ?? 'BRL')));
  const currencyCode = currencies.size === 1 ? [...currencies][0]! : 'BRL';

  const byCategory = new Map<string, number>();
  for (const r of active) {
    const key = r.categoryId ?? 'sem-categoria';
    byCategory.set(key, (byCategory.get(key) ?? 0) + r.annualizedCost);
  }

  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM recurring_analysis').get() as { n: number };
  const occurrencesRow = db.prepare('SELECT COUNT(*) AS n FROM recurring_occurrences').get() as { n: number };

  return {
    period: { from: addDaysCivil(currentDay, -365), to: addDaysCivil(currentDay, 1), timezone },
    currencyCode,
    counts: {
      recurrences: recurrences.length,
      occurrences: occurrencesRow.n,
      persistedSeries: totalRow.n,
      activeSeries: active.length,
    },
    quality: worstQuality(
      currencies.size > 1 ? 'not_comparable' : 'complete',
      recurrences.length === 0 ? 'insufficient' : 'complete'
    ),
    data: {
      annualizedTotal: {
        amount: Math.round(active.reduce((acc, r) => acc + r.annualizedCost, 0) * 100) / 100,
        currencyCode,
        metricId: `recurrences-annualized-total:${currencyCode}`,
      },
      annualizedByCategory: [...byCategory.entries()]
        .map(([categoryId, amount]) => ({
          categoryId: categoryId === 'sem-categoria' ? null : categoryId,
          label: labels.get(categoryId) ?? null,
          amount: Math.round(amount * 100) / 100,
          currencyCode,
          metricId: `recurrences-annualized-category:${categoryId}:${currencyCode}`,
        }))
        .sort((a, b) => b.amount - a.amount),
      recurrences,
    },
  };
}
