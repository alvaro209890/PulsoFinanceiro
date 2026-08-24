/**
 * Análises F4 — poupança (docs/12 §8, docs/09 §poupança).
 *
 * variação_residual = variação_saldo − aportes_internos + retiradas_internas.
 * Aportes/retiradas internas são movimentações ENTRE contas do próprio
 * usuário (categoria raiz 04 ou flag), que não podem inflar rendimento.
 *
 * estimatedYield fica null até a semântica da fonte estar confirmada
 * (gate docs/07). Meta deriva do histórico (mediana dos 6 meses) e não
 * tem campo de criação/edição. Streak = meses consecutivos batendo a meta.
 */
import type { Db } from '../db/index.js';
import { fromMinor } from './ledger.js';

export const SAVINGS_METRIC_VERSION = 'savings.v1';

export interface SavingsMonth {
  month: string; // YYYY-MM
  balanceStart: number | null;
  balanceEnd: number | null;
  variation: number | null;
  internalIn: number;
  internalOut: number;
  residualVariation: number | null;
}

export function savingsEvolution(
  db: Db,
  params: { months?: number; timezone?: string }
): {
  months: SavingsMonth[];
  medianResidual: number | null;
  goalMonthly: number;
  streakMonths: number;
  estimatedYield: null;
} {
  const monthsBack = Math.min(params.months ?? 6, 12);

  // Contas elegíveis para saldo: todas (saldo consolidado)
  const balances = monthlyBalances(db, monthsBack + 1);
  const internals = internalFlowsByMonth(db, monthsBack);

  const out: SavingsMonth[] = [];
  const residuals: number[] = [];

  for (let i = 1; i < balances.length; i += 1) {
    const prev = balances[i - 1]!;
    const cur = balances[i]!;
    if (prev.balance === null || cur.balance === null) continue;
    const variation = cur.balance - prev.balance;
    const flows = internals.get(cur.month) ?? { inMinor: 0, outMinor: 0 };
    const residual = variation + fromMinor(flows.outMinor) - fromMinor(flows.inMinor);
    residuals.push(residual);
    out.push({
      month: cur.month,
      balanceStart: prev.balance,
      balanceEnd: cur.balance,
      variation: round2(variation),
      internalIn: fromMinor(flows.inMinor),
      internalOut: fromMinor(flows.outMinor),
      residualVariation: round2(residual),
    });
  }

  const medianResidual = residuals.length ? median(residuals.map(round2)) : null;
  // Meta deriva do histórico: mediana dos últimos 6 meses de residual
  const goalMonthly = medianResidual !== null ? Math.max(0, round2(medianResidual)) : 0;

  // Streak: meses consecutivos (do mais recente pra trás) com residual >= meta
  let streak = 0;
  for (let i = out.length - 1; i >= 0 && goalMonthly > 0; i -= 1) {
    const m = out[i]!;
    if ((m.residualVariation ?? -Infinity) >= goalMonthly) streak += 1;
    else break;
  }

  return { months: out, medianResidual, goalMonthly, streakMonths: streak, estimatedYield: null };
}

interface BalancePoint {
  month: string;
  balance: number | null;
}

/** Saldo consolidado no último instante de cada mês (dos snapshots/balances). */
function monthlyBalances(db: Db, monthsBack: number): BalancePoint[] {
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS ym, MAX(updated_at) AS at
         FROM (
           SELECT date AS date, updated_at FROM transactions
         )
        GROUP BY ym
        ORDER BY ym DESC LIMIT ?`
    )
    .all(monthsBack) as Array<{ ym: string }>;

  // Saldo por mês = último balance_after conhecido somado entre contas.
  // Simplificação F4: usa SUM(balance_after) do último POSTED de cada conta/mês.
  const out: BalancePoint[] = [];
  for (const r of rows.reverse()) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(b.balance), 0) AS total
           FROM (
             SELECT balance_after AS balance,
                    ROW_NUMBER() OVER (
                      PARTITION BY account_public_id
                      ORDER BY date DESC, order_tiebreak DESC
                    ) AS rn
               FROM transactions
              WHERE status='POSTED' AND balance_after IS NOT NULL
                AND substr(date,1,7) <= ?
           ) b
          WHERE b.rn = 1`
      )
      .get(r.ym) as { total: number };
    out.push({ month: r.ym, balance: round2(row.total) });
  }
  return out;
}

function internalFlowsByMonth(
  db: Db,
  monthsBack: number
): Map<string, { inMinor: number; outMinor: number }> {
  const rows = db
    .prepare(
      `SELECT substr(date,1,7) AS ym, type, SUM(amount*100) AS minor
         FROM transactions
        WHERE status='POSTED'
          AND (is_internal_transfer=1 OR (category_id IS NOT NULL AND substr(category_id,1,2)='04'))
          AND type IS NOT NULL
        GROUP BY ym, type
        ORDER BY ym DESC LIMIT ?`
    )
    .all(monthsBack * 4) as Array<{ ym: string; type: string; minor: number }>;

  const map = new Map<string, { inMinor: number; outMinor: number }>();
  for (const r of rows) {
    const entry = map.get(r.ym) ?? { inMinor: 0, outMinor: 0 };
    if (r.type === 'CREDIT') entry.inMinor += r.minor;
    else if (r.type === 'DEBIT') entry.outMinor += r.minor;
    map.set(r.ym, entry);
  }
  return map;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
