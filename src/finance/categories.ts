/**
 * Rollup de categoria e comparação mês a mês — docs/09 §7.1 e §7.2,
 * contrato `GET /api/v1/analytics/categories` (docs/07).
 *
 * raiz = dois primeiros dígitos do `categoryId`; o nível seguinte agrupa
 * pelo `categoryId` integral. Rótulo vem de `categories` sincronizada.
 * “Sem categoria” (`00`) e “Outros” (`99`) são grupos DISTINTOS.
 * Prefixo `04` é transferência interna e não entra em gasto.
 *
 * Mês parcial compara somente os mesmos dias do mês anterior; base zero
 * devolve `deltaPercent = null` e `newInPeriod = true`, nunca infinito.
 */
import type { Db } from '../db/index.js';
import {
  addMonths,
  dayOfMonth,
  daysBetween,
  daysInMonth,
  DEFAULT_TIMEZONE,
  addDays,
  monthOf,
  monthRange,
} from './time.js';
import { fromMinor, loadLedger, NO_CATEGORY_ROOT, type LedgerRow } from './ledger.js';
import { worstQuality, type Quality } from './envelope.js';

export const CATEGORIES_METRIC_VERSION = 'categories-rollup.v1';

export const NO_CATEGORY_LABEL = 'Sem categoria';
export const OTHERS_ROOT = '99';

export interface CategoryChild {
  categoryId: string | null;
  label: string | null;
  postedAmount: number;
  pendingAmount: number;
  metricId: string;
}

export interface CategoryRollup {
  categoryId: string;
  rootCode: string;
  label: string;
  postedAmount: number;
  pendingAmount: number;
  previousComparableAmount: number;
  deltaAmount: number;
  deltaPercent: number | null;
  newInPeriod: boolean;
  monthlySeries: Array<{
    month: string;
    comparableThroughDay: number;
    postedAmount: number;
    metricIds: Record<string, string>;
  }>;
  metricIds: Record<string, string>;
  children: CategoryChild[];
}

export interface CategoriesData {
  total: {
    postedAmount: number;
    pendingAmount: number;
    metricIds: Record<string, string>;
  };
  categories: CategoryRollup[];
}

export interface CategoriesResult {
  period: { from: string; to: string; timezone: string };
  currencyCode: string;
  counts: Record<string, number>;
  quality: Quality;
  data: CategoriesData;
}

export interface CategoriesOptions {
  from: string;
  to: string;
  rootCode?: string;
  includePending?: boolean;
  timezone?: string;
}

export function computeCategories(db: Db, options: CategoriesOptions): CategoriesResult {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const includePending = options.includePending ?? false;
  const { from, to } = options;

  const previous = previousComparableWindow(from, to);
  const ledger = loadLedger(db, { from: previous.from, to, timezone });
  const labels = loadLabels(db);

  const inPeriod = ledger.rows.filter((r) => r.date >= from && r.date < to);
  const inPrevious = ledger.rows.filter((r) => previous.contains(r.date));

  const currentByRoot = aggregate(inPeriod);
  const previousByRoot = aggregate(inPrevious);

  const periodLabel = monthOf(from);
  const rollups: CategoryRollup[] = [];
  let totalPosted = 0;
  let totalPending = 0;

  for (const [rootCode, bucket] of currentByRoot) {
    totalPosted += bucket.postedMinor;
    totalPending += bucket.pendingMinor;
    if (options.rootCode && options.rootCode !== rootCode) continue;

    const prevMinor = previousByRoot.get(rootCode)?.postedMinor ?? 0;
    const deltaMinor = bucket.postedMinor - prevMinor;
    const deltaPercent = prevMinor > 0 ? round4((deltaMinor / prevMinor) * 100) : null;

    const children: CategoryChild[] = [...bucket.children.entries()]
      .map(([categoryId, child]) => ({
        categoryId: categoryId === NO_CATEGORY_ROOT ? null : categoryId,
        label: labels.get(categoryId) ?? null,
        postedAmount: fromMinor(child.postedMinor),
        pendingAmount: includePending ? fromMinor(child.pendingMinor) : 0,
        metricId: `category-posted:${categoryId}:${periodLabel}`,
      }))
      .sort((a, b) => b.postedAmount - a.postedAmount || compareIds(a.categoryId, b.categoryId));

    rollups.push({
      categoryId: rootCode,
      rootCode,
      label: rootLabel(rootCode, labels, bucket.children),
      postedAmount: fromMinor(bucket.postedMinor),
      pendingAmount: includePending ? fromMinor(bucket.pendingMinor) : 0,
      previousComparableAmount: fromMinor(prevMinor),
      deltaAmount: fromMinor(deltaMinor),
      deltaPercent,
      newInPeriod: prevMinor === 0 && bucket.postedMinor > 0,
      monthlySeries: monthlySeries(rootCode, ledger.rows, from, to, periodLabel),
      metricIds: {
        postedAmount: `category-posted:${rootCode}:${periodLabel}`,
        pendingAmount: `category-pending:${rootCode}:${periodLabel}`,
        previousComparableAmount: `category-previous-comparable:${rootCode}:${periodLabel}`,
        deltaAmount: `category-delta:${rootCode}:${periodLabel}`,
        deltaPercent: `category-delta-percent:${rootCode}:${periodLabel}`,
      },
      children,
    });
  }

  rollups.sort((a, b) => b.postedAmount - a.postedAmount || a.categoryId.localeCompare(b.categoryId));

  const taxonomySynced = labels.size > 0;
  const quality = worstQuality(
    ledger.currencies.length > 1 ? 'not_comparable' : 'complete',
    inPeriod.some((r) => r.cardCreditUnclassified) ? 'partial' : 'complete',
    inPrevious.length === 0 && previous.exists ? 'insufficient' : 'complete'
  );

  return {
    period: { from, to, timezone },
    currencyCode: ledger.currencyCode,
    counts: {
      categories: rollups.length,
      transactions: inPeriod.length,
      taxonomyCategories: labels.size,
      cardCreditUnclassified: inPeriod.filter((r) => r.cardCreditUnclassified).length,
    },
    quality: taxonomySynced ? quality : worstQuality(quality, 'partial'),
    data: {
      total: {
        postedAmount: fromMinor(totalPosted),
        pendingAmount: includePending ? fromMinor(totalPending) : 0,
        metricIds: {
          postedAmount: `categories-posted-total:${periodLabel}`,
          pendingAmount: `categories-pending-total:${periodLabel}`,
        },
      },
      categories: rollups,
    },
  };
}

interface Bucket {
  postedMinor: number;
  pendingMinor: number;
  children: Map<string, { postedMinor: number; pendingMinor: number }>;
}

function aggregate(rows: readonly LedgerRow[]): Map<string, Bucket> {
  const byRoot = new Map<string, Bucket>();
  for (const r of rows) {
    if (!r.spendPosted && !r.spendPending) continue;
    const bucket = byRoot.get(r.rootCode) ?? {
      postedMinor: 0,
      pendingMinor: 0,
      children: new Map<string, { postedMinor: number; pendingMinor: number }>(),
    };
    const childKey = r.categoryId ?? NO_CATEGORY_ROOT;
    const child = bucket.children.get(childKey) ?? { postedMinor: 0, pendingMinor: 0 };
    if (r.spendPosted) {
      bucket.postedMinor += r.amountMinor;
      child.postedMinor += r.amountMinor;
    } else {
      bucket.pendingMinor += r.amountMinor;
      child.pendingMinor += r.amountMinor;
    }
    bucket.children.set(childKey, child);
    byRoot.set(r.rootCode, bucket);
  }
  return byRoot;
}

/**
 * Janela anterior comparável. Quando o período começa no dia 1 de um mês,
 * compara o MESMO recorte de dias do mês anterior (docs/09 §7.2). Fora
 * disso, usa a janela imediatamente anterior com a mesma quantidade de dias.
 */
export function previousComparableWindow(
  from: string,
  to: string
): { from: string; to: string; contains: (date: string) => boolean; exists: boolean } {
  if (dayOfMonth(from) === 1) {
    const month = monthOf(from);
    const lastIncluded = addDays(to, -1);
    const throughDay =
      monthOf(lastIncluded) === month ? dayOfMonth(lastIncluded) : daysInMonth(month);
    const prevMonth = addMonths(month, -1);
    const prevThroughDay = Math.min(throughDay, daysInMonth(prevMonth));
    const prevRange = monthRange(prevMonth);
    const prevTo = `${prevMonth}-${String(prevThroughDay).padStart(2, '0')}`;
    return {
      from: prevRange.from,
      to: addDays(prevTo, 1),
      contains: (date) => monthOf(date) === prevMonth && dayOfMonth(date) <= prevThroughDay,
      exists: true,
    };
  }
  const length = daysBetween(from, to);
  const prevFrom = addDays(from, -length);
  return {
    from: prevFrom,
    to: from,
    contains: (date) => date >= prevFrom && date < from,
    exists: length > 0,
  };
}

function monthlySeries(
  rootCode: string,
  rows: readonly LedgerRow[],
  from: string,
  to: string,
  periodLabel: string
): CategoryRollup['monthlySeries'] {
  const months = new Set<string>();
  for (let m = monthOf(from); m <= monthOf(addDays(to, -1)); m = addMonths(m, 1)) months.add(m);
  const out: CategoryRollup['monthlySeries'] = [];
  for (const month of months) {
    const monthRows = rows.filter(
      (r) => monthOf(r.date) === month && r.rootCode === rootCode && r.spendPosted && r.date >= from && r.date < to
    );
    const lastIncluded = addDays(to, -1);
    const comparableThroughDay =
      monthOf(lastIncluded) === month ? dayOfMonth(lastIncluded) : daysInMonth(month);
    out.push({
      month,
      comparableThroughDay,
      postedAmount: fromMinor(monthRows.reduce((acc, r) => acc + r.amountMinor, 0)),
      metricIds: {
        comparableThroughDay: `category-month-comparable-through-day:${rootCode}:${month}`,
        postedAmount: `category-month:${rootCode}:${month}:day-${comparableThroughDay}`,
      },
    });
  }
  void periodLabel;
  return out;
}

function loadLabels(db: Db): Map<string, string> {
  const rows = db.prepare('SELECT id, description_translated FROM categories').all() as Array<{
    id: string;
    description_translated: string;
  }>;
  return new Map(rows.map((r) => [r.id, r.description_translated]));
}

/**
 * Rótulo da raiz: categoria raiz sincronizada quando existir, senão o rótulo
 * do próprio filho. “Outros” (`99`) não recebe tradução inventada.
 */
function rootLabel(
  rootCode: string,
  labels: Map<string, string>,
  children: Map<string, { postedMinor: number; pendingMinor: number }>
): string {
  if (rootCode === NO_CATEGORY_ROOT) return NO_CATEGORY_LABEL;
  const canonical = labels.get(`${rootCode}000000`);
  if (canonical) return canonical;
  for (const childId of children.keys()) {
    const label = labels.get(childId);
    if (label) return label;
  }
  return rootCode === OTHERS_ROOT ? 'Outros' : rootCode;
}

function compareIds(a: string | null, b: string | null): number {
  return (a ?? '').localeCompare(b ?? '');
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
