/**
 * Outbox — docs/14-integracao-hermes.md §Outbox persistente.
 *
 * Criação do evento na MESMA transação SQLite que confirma a métrica
 * (regra do plano). Dedup ativo somente no episódio: índice parcial em
 * condition_closed_at IS NULL. Nova observação atualiza last_occurred_at/
 * occurrence_count; entrega nunca fecha condição.
 */
import type { Db } from './index.js';
import { ulid } from 'ulid';

export type OutboxSeverity = 'INFO' | 'WARNING' | 'HIGH' | 'CRITICAL';

export interface EmitEventInput {
  eventType: string;
  severity: OutboxSeverity;
  dedupKey: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

export function emitEvent(db: Db, input: EmitEventInput): { id: string; created: boolean } {
  const existing = db
    .prepare(
      `SELECT id, occurrence_count FROM outbox_events
       WHERE dedup_key = ? AND condition_closed_at IS NULL`
    )
    .get(input.dedupKey) as { id: string; occurrence_count: number } | undefined;

  const now = new Date().toISOString();

  if (existing) {
    db.prepare(
      `UPDATE outbox_events SET last_occurred_at = ?, occurrence_count = occurrence_count + 1,
       available_at = ? WHERE id = ?`
    ).run(now, now, existing.id);
    return { id: existing.id, created: false };
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO outbox_events (id, event_type, severity, payload_json, dedup_key,
     status, occurred_at, last_occurred_at)
     VALUES (?,?,?,?,?, 'PENDING', ?, ?)`
  ).run(id, input.eventType, input.severity, JSON.stringify(input.payload), input.dedupKey, input.occurredAt ?? now, now);
  return { id, created: true };
}

/** Fecha o episódio ativo de uma condição (recuperação provada — docs/14). */
export function closeCondition(db: Db, dedupKey: string): boolean {
  const res = db
    .prepare(
      `UPDATE outbox_events SET condition_closed_at = ?
       WHERE dedup_key = ? AND condition_closed_at IS NULL`
    )
    .run(new Date().toISOString(), dedupKey);
  return res.changes > 0;
}
