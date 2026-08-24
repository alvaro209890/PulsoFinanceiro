/**
 * Análises F4 — anomalias e duplicidades (docs/12 §8).
 *
 * Duplicidade: mesmo valor absoluto, janela estritamente inferior a 24h,
 * IDs distintos, mesma conta, ambos POSTED DEBIT fora de transferência
 * interna. Dois IDs SEMPRE — nunca confunde upsert de status.
 *
 * LOG_ZSCORE: dentro de categoria, sobre log(valor). Amostra mínima 20
 * transações confirmadas na categoria; desvio-padrão zero → não executa
 * (docs/07 gate). NÃO é z-score robusto — o nome é LOG_ZSCORE.
 */
import type { Db } from '../db/index.js';
import { fromMinor } from './ledger.js';

export const ANOMALIES_METRIC_VERSION = 'anomalies.v1';

export interface DuplicatePair {
  ids: [string, string];
  amountMinor: number;
  amount: number;
  minutesApart: number;
  dates: [string, string];
}

export function findDuplicates(
  db: Db,
  params: { from: string; to: string; timezone?: string }
): { duplicates: DuplicatePair[]; currencyCode: string } {
  const { fromPad, toPad } = sqlWindow(params.from, params.to);
  const rows = db
    .prepare(
      `SELECT t.public_id, t.amount, t.date, t.account_public_id
         FROM transactions t
        WHERE t.type = 'DEBIT' AND t.status = 'POSTED'
          AND t.is_internal_transfer = 0
          AND substr(t.date,1,10) >= ?
          AND substr(t.date,1,10) <  ?
        ORDER BY t.date ASC`
    )
    .all(fromPad, toPad) as Array<{
      public_id: string;
      amount: number;
      date: string;
      account_public_id: string;
    }>;

  const amountById = new Map(rows.map((r) => [r.public_id, r.amount]));

  // Índice por (conta, valor em centavos) para comparação O(n) por bucket
  const buckets = new Map<string, Array<{ id: string; ts: number; date: string }>>();
  for (const r of rows) {
    const key = `${r.account_public_id}:${Math.round(r.amount * 100)}`;
    const entry = { id: r.public_id, ts: Date.parse(r.date), date: r.date };
    const list = buckets.get(key);
    if (list) list.push(entry);
    else buckets.set(key, [entry]);
  }

  const seen = new Set<string>();
  const duplicates: DuplicatePair[] = [];
  for (const entries of buckets.values()) {
    for (let i = 0; i < entries.length; i += 1) {
      const a = entries[i]!;
      for (let j = i + 1; j < entries.length; j += 1) {
        const b = entries[j]!;
        const minutesApart = Math.abs(a.ts - b.ts) / 60_000;
        if (minutesApart >= 24 * 60) continue; // janela ESTRITAMENTE < 24h
        const pairKey = [a.id, b.id].sort().join(':');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const amount = amountById.get(a.id) ?? 0;
        duplicates.push({
          ids: [a.id, b.id],
          amountMinor: Math.round(amount * 100),
          amount,
          minutesApart: Math.round(minutesApart),
          dates: [a.date.slice(0, 10), b.date.slice(0, 10)],
        });
      }
    }
  }

  return { duplicates, currencyCode: 'BRL' };
}

// ─── LOG_ZSCORE ─────────────────────────────────────────────────────────

const MIN_SAMPLE = 20;

export interface Anomaly {
  transactionId: string;
  categoryId: string | null;
  categoryLabel: string | null;
  amountMinor: number;
  amount: number;
  categoryMedian: number;
  score: number; // |z| em log-espaco
  sampleSize: number;
}

/**
 * Detecta anomalias por categoria usando log-zscore.
 * Amostra < 20 → METRIC_NOT_AVAILABLE (chamador decide o HTTP).
 */
export function logZscoreAnomalies(
  db: Db,
  params: { from: string; to: string; threshold?: number }
): {
  anomalies: Anomaly[];
  categoriesEvaluated: number;
  categoriesSkippedLowSample: number;
} {
  const threshold = params.threshold ?? 3;
  const { fromPad, toPad } = sqlWindow(params.from, params.to);

  const rows = db
    .prepare(
      `SELECT t.public_id, t.amount, t.date, t.category_id,
              c.description_translated AS category_label
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.type = 'DEBIT' AND t.status = 'POSTED'
          AND t.is_internal_transfer = 0
          AND (t.category_id IS NULL OR substr(t.category_id,1,2) != '04')
          AND substr(t.date,1,10) >= ?
          AND substr(t.date,1,10) <  ?`
    )
    .all(fromPad, toPad) as Array<{
      public_id: string;
      amount: number;
      date: string;
      category_id: string | null;
      category_label: string | null;
    }>;

  // Histórico completo por categoria para média/dp do log
  const history = db
    .prepare(
      `SELECT category_id, COUNT(*) AS n, AVG(ln_amount) AS mean, COUNT(*) > 0 AS has
         FROM (
           SELECT category_id, ln(amount) AS ln_amount
             FROM transactions
            WHERE type='DEBIT' AND status='POSTED' AND is_internal_transfer=0
              AND category_id IS NOT NULL AND amount > 0
         )
        GROUP BY category_id`
    )
    .all() as Array<{ category_id: string; n: number; mean: number }>;

  const dpByCategory = new Map<string, { mean: number; dp: number; n: number }>();
  const byCategoryAll = new Map<string, number[]>();
  {
    const allRows = db
      .prepare(
        `SELECT category_id, amount FROM transactions
          WHERE type='DEBIT' AND status='POSTED' AND is_internal_transfer=0
            AND category_id IS NOT NULL AND amount > 0`
      )
      .all() as Array<{ category_id: string; amount: number }>;
    for (const r of allRows) {
      const list = byCategoryAll.get(r.category_id) ?? [];
      list.push(Math.log(r.amount));
      byCategoryAll.set(r.category_id, list);
    }
  }
  for (const [cat, logs] of byCategoryAll) {
    const n = logs.length;
    if (n < MIN_SAMPLE) continue;
    const mean = logs.reduce((a, b) => a + b, 0) / n;
    const variance = logs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
    const dp = Math.sqrt(variance);
    if (dp > 0) dpByCategory.set(cat, { mean, dp, n });
  }

  void history;

  const anomalies: Anomaly[] = [];
  let skipped = 0;
  const evaluatedCats = new Set<string>();

  for (const r of rows) {
    if (!r.category_id || r.amount <= 0) continue;
    const stats = dpByCategory.get(r.category_id);
    if (!stats) {
      skipped += 1;
      continue;
    }
    evaluatedCats.add(r.category_id);
    const z = Math.abs((Math.log(r.amount) - stats.mean) / stats.dp);
    if (z >= threshold) {
      anomalies.push({
        transactionId: r.public_id,
        categoryId: r.category_id,
        categoryLabel: r.category_label,
        amountMinor: Math.round(r.amount * 100),
        amount: r.amount,
        categoryMedian: Math.round(Math.exp(stats.mean) * 100) / 100,
        score: Math.round(z * 100) / 100,
        sampleSize: stats.n,
      });
    }
  }

  // conta categorias puladas com amostra baixa
  for (const cat of new Set(rows.map((r) => r.category_id).filter((c): c is string => !!c))) {
    if (!dpByCategory.has(cat)) evaluatedCats.delete(cat);
  }

  anomalies.sort((a, b) => b.score - a.score);
  return {
    anomalies,
    categoriesEvaluated: evaluatedCats.size,
    categoriesSkippedLowSample: skipped,
  };
}

void fromMinor;

/**
 * Janela SQL: SQLite não aplica modificador '-1 day' a parâmetro `?`.
 * Calcula bordas com folga de ±1 dia na aplicação.
 */
export function sqlWindow(from: string, to: string): { fromPad: string; toPad: string } {
  const pad = (isoDate: string, days: number): string => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return { fromPad: pad(from, -1), toPad: pad(to, 1) };
}
