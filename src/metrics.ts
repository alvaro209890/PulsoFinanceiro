/**
 * Métricas determinísticas — docs/07-api-interna.md §fechamento.
 * O backend calcula; frontend e Hermes apenas consomem (nunca recalculam).
 */
import type { Db } from './db/index.js';

export interface MonthlySummary {
  schemaVersion: 1;
  period: string; // YYYY-MM
  computedAt: string;
  dataThrough: string | null;
  income: number;
  spend: number;
  net: number;
  byCategory: Array<{ categoryId: string | null; label: string | null; total: number }>;
  pendingCount: number;
}

/** Fechamento do mês: entradas confirmadas − saídas confirmadas, por categoria. */
export function monthlySummary(db: Db, period: string): MonthlySummary {
  const rows = db
    .prepare(
      `SELECT date, amount, type, status, category_id, is_internal_transfer
       FROM transactions
       WHERE substr(date,1,7) = ? AND account_public_id IN (SELECT public_id FROM accounts)`
    )
    .all(period) as Array<{
      date: string;
      amount: number;
      type: string | null;
      status: string;
      category_id: string | null;
      is_internal_transfer: number;
    }>;

  let income = 0;
  let spend = 0;
  let pendingCount = 0;
  const catTotals = new Map<string, number>();

  for (const r of rows) {
    if (r.is_internal_transfer === 1) continue; // fora do gasto (docs/01)
    if (r.status !== 'POSTED') {
      pendingCount += 1;
      continue;
    }
    if (r.type === 'CREDIT') {
      income += r.amount;
    } else if (r.type === 'DEBIT') {
      spend += r.amount;
      const key = r.category_id ?? 'sem-categoria';
      catTotals.set(key, (catTotals.get(key) ?? 0) + r.amount);
    }
  }

  const labels = db.prepare('SELECT id, description_translated FROM categories').all() as Array<{
    id: string;
    description_translated: string;
  }>;
  const labelMap = new Map(labels.map((l) => [l.id, l.description_translated]));

  return {
    schemaVersion: 1,
    period,
    computedAt: new Date().toISOString(),
    dataThrough: dataThrough(db),
    income: round2(income),
    spend: round2(spend),
    net: round2(income - spend),
    byCategory: [...catTotals.entries()]
      .map(([categoryId, total]) => ({
        categoryId: categoryId === 'sem-categoria' ? null : categoryId,
        label: labelMap.get(categoryId) ?? null,
        total: round2(total),
      }))
      .sort((a, b) => b.total - a.total),
    pendingCount,
  };
}

function dataThrough(db: Db): string | null {
  const row = db.prepare('SELECT MAX(date) AS d FROM transactions').get() as { d: string | null };
  return row.d ?? null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
