/**
 * Worker da inbox de webhook — docs/06 §7 (recepção síncrona, trabalho assíncrono).
 *
 * Regras implementadas:
 * - item/updated: primeiro passo é GET /items/{id}; nunca decidir pelo payload;
 * - transactions/*: confirmar accountId pertence ao itemId configurado;
 *   conta desconhecida dispara refresh de /accounts; fora do escopo → DEAD
 *   ACCOUNT_SCOPE_INVALID;
 * - reentrega da Pluggy (até 9x) é inofensiva: conflito em status não-FAILED
 *   mantém a linha original e responde 202.
 */
import type { Db } from '../db/index.js';
import type { PluggyClient } from '../pluggy/client.js';
import { syncItem } from './sync.js';

export interface InboxEnvelope {
  eventId: string;
  eventType: 'item/updated' | 'transactions/created' | 'transactions/updated' | 'transactions/deleted';
  itemId?: string | null;
  accountId?: string | null;
  triggeredBy?: string | null;
  transactionIds?: string[] | null;
}

const ALLOWED_TYPES = new Set([
  'item/updated',
  'transactions/created',
  'transactions/updated',
  'transactions/deleted',
]);

/** Recepção síncrona (chamada pela rota após validar Bearer). 202 = aceito. */
export function receiveEnvelope(db: Db, envelope: InboxEnvelope): { accepted: boolean; reason?: string } {
  if (!envelope.eventId || !ALLOWED_TYPES.has(envelope.eventType)) {
    return { accepted: false, reason: 'ENVELOPE_INVALID' };
  }
  const needsAccount = envelope.eventType.startsWith('transactions/');
  if (needsAccount && !envelope.accountId) {
    return { accepted: false, reason: 'ACCOUNT_REQUIRED' };
  }
  if ((envelope.eventType === 'transactions/updated' || envelope.eventType === 'transactions/deleted')
      && (!envelope.transactionIds || envelope.transactionIds.length === 0)) {
    return { accepted: false, reason: 'TRANSACTION_IDS_REQUIRED' };
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO webhook_inbox (event_id, event_type, item_id, account_id, triggered_by, payload_json, status, attempts, received_at)
     VALUES (?,?,?,?,?,?, 'RECEIVED', 0, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       status = 'RECEIVED', processing_started_at = NULL, next_attempt_at = excluded.received_at
     WHERE webhook_inbox.status = 'FAILED'`
  ).run(
    envelope.eventId,
    envelope.eventType,
    envelope.itemId ?? null,
    envelope.accountId ?? null,
    envelope.triggeredBy ?? null,
    JSON.stringify({ ...envelope }),
    now
  );
  return { accepted: true };
}

/**
 * Processa envelopes RECEIVED pendentes. Retorna quantos foram processados.
 * O trabalho real do item/updated é um harvest (GET /items + contas +
 * transações), que cumpre a regra "payload é só aviso".
 */
export async function processInbox(
  db: Db,
  client: PluggyClient,
  configuredItemId: string,
  limit = 10
): Promise<{ processed: number; dead: number }> {
  const pending = db
    .prepare(
      `SELECT event_id, event_type, account_id FROM webhook_inbox
       WHERE status IN ('RECEIVED','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY received_at LIMIT ?`
    )
    .all(new Date().toISOString(), limit) as Array<{
      event_id: string;
      event_type: string;
      account_id: string | null;
    }>;

  let processed = 0;
  let dead = 0;

  for (const ev of pending) {
    const started = db
      .prepare(
        `UPDATE webhook_inbox SET status='PROCESSING', processing_started_at=?,
         attempts = attempts + 1 WHERE event_id = ? AND status IN ('RECEIVED','FAILED')`
      )
      .run(new Date().toISOString(), ev.event_id);
    if (started.changes === 0) continue; // outro worker pegou

    try {
      // Escopo: transações exigem accountId conhecido do item configurado.
      // Conta ainda desconhecida dispara refresh de /accounts; persistindo
      // a ausência, termina DEAD ACCOUNT_SCOPE_INVALID (docs/06 §7).
      if (ev.account_id) {
        let known = db.prepare('SELECT public_id FROM accounts WHERE external_id = ?').get(ev.account_id);
        if (!known) {
          await client.getAccounts(configuredItemId);
          known = db.prepare('SELECT public_id FROM accounts WHERE external_id = ?').get(ev.account_id);
        }
        if (!known) throw new Error('ACCOUNT_SCOPE_INVALID');
      }

      // Trabalho real: harvest completo do item (payload é só aviso)
      const result = await syncItem(db, client, configuredItemId, 'webhook-triggered' as never);
      if (!result.ok) throw new Error(result.errorCode ?? 'SYNC_FAILED');

      db.prepare(
        `UPDATE webhook_inbox SET status='SUCCEEDED', processed_at=? WHERE event_id=?`
      ).run(new Date().toISOString(), ev.event_id);
      processed += 1;
    } catch (err) {
      const attempts = db.prepare('SELECT attempts FROM webhook_inbox WHERE event_id=?').get(ev.event_id) as { attempts: number };
      const code = err instanceof Error ? err.message.slice(0, 60) : 'UNKNOWN';
      // Falha de escopo é permanente; as demais tentam de novo (docs/06 §10)
      const isDead = /ACCOUNT_SCOPE|CURSOR_LOOP|CREDENTIAL/.test(code) || attempts.attempts >= 3;
      db.prepare(
        `UPDATE webhook_inbox SET status=?, last_error_code=?, next_attempt_at=?
         WHERE event_id=?`
      ).run(
        isDead ? 'DEAD' : 'FAILED',
        code,
        isDead ? null : new Date(Date.now() + 15 * 60_000).toISOString(),
        ev.event_id
      );
      if (isDead) dead += 1;
    }
  }
  return { processed, dead };
}
