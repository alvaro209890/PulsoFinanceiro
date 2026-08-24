/**
 * Envelope comum das métricas — docs/07 §envelope de sucesso agregado.
 *
 * Toda resposta agregada informa `computedAt`, `dataThrough`, `period`,
 * `currencyCode`, `counts`, `metricVersion` e `quality`. Não existe um
 * segundo relógio concorrente (`asOf`). `metricId` só aparece no objeto
 * métrico que ele identifica.
 */
import type { Db } from '../db/index.js';
import { DEFAULT_TIMEZONE } from './time.js';

export type Quality =
  | 'complete'
  | 'partial'
  | 'insufficient'
  | 'stale'
  | 'not_comparable'
  | 'unavailable';

/** Precedência: o pior estado observado vence (docs/09 §2.4). */
const QUALITY_ORDER: Record<Quality, number> = {
  complete: 0,
  partial: 1,
  stale: 2,
  insufficient: 3,
  not_comparable: 4,
  unavailable: 5,
};

export function worstQuality(...values: Quality[]): Quality {
  return values.reduce((acc, q) => (QUALITY_ORDER[q] > QUALITY_ORDER[acc] ? q : acc), 'complete');
}

export interface Envelope<T> {
  schemaVersion: '1.0';
  computedAt: string;
  dataThrough: string | null;
  period: { from: string; to: string; timezone: string };
  currencyCode: string;
  counts: Record<string, number>;
  metricVersion: string;
  quality: Quality;
  data: T;
}

export interface EnvelopeInput<T> {
  period: { from: string; to: string; timezone?: string };
  currencyCode: string;
  counts: Record<string, number>;
  metricVersion: string;
  quality: Quality;
  dataThrough: string | null;
  data: T;
  now?: Date;
}

export function buildEnvelope<T>(input: EnvelopeInput<T>): Envelope<T> {
  return {
    schemaVersion: '1.0',
    computedAt: (input.now ?? new Date()).toISOString(),
    dataThrough: input.dataThrough,
    period: {
      from: input.period.from,
      to: input.period.to,
      timezone: input.period.timezone ?? DEFAULT_TIMEZONE,
    },
    currencyCode: input.currencyCode,
    counts: input.counts,
    metricVersion: input.metricVersion,
    quality: input.quality,
    data: input.data,
  };
}

/**
 * Instante do dado mais recente que sustenta a métrica: o maior entre o fim
 * do último harvest bem-sucedido e a última escrita de transação.
 */
export function dataThroughInstant(db: Db): string | null {
  const row = db
    .prepare(
      `SELECT MAX(v) AS v FROM (
         SELECT MAX(finished_at) AS v FROM sync_runs WHERE ok = 1
         UNION ALL
         SELECT MAX(updated_at) AS v FROM transactions
         UNION ALL
         SELECT MAX(captured_at) AS v FROM balance_snapshots
       )`
    )
    .get() as { v: string | null } | undefined;
  return row?.v ?? null;
}

/** Revisão de dados usada no ETag dos agregados (docs/07 §cache e ETag). */
export function dataRevision(db: Db): number {
  const row = db.prepare(`SELECT value FROM system_state WHERE key = 'data_revision'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 1;
}

/** Incrementa a revisão no mesmo commit que altera dado servido em métrica. */
export function bumpDataRevision(db: Db): number {
  db.prepare(
    `UPDATE system_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_revision'`
  ).run();
  return dataRevision(db);
}

export function etagFor(db: Db, metricVersion: string, normalizedFilters: string): string {
  return `W/"${metricVersion}:${normalizedFilters}:${dataRevision(db)}"`;
}
