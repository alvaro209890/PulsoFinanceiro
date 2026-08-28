/**
 * STALE_POLICY_V1 — docs/14 §Catálogo e widget de saúde.
 *
 * Regra: ausência de harvest posterior a nextAutoSyncAt + 6h E idade de
 * dataThrough ≥ 24h. Com nextAutoSyncAt = null, combina idade do dataThrough
 * com status/erro do item. Faixas: 24–<72h WARNING; 72–<168h HIGH; ≥168h CRITICAL.
 * Dedup por episódio: dedup_key = `sync-stale:{itemPublicId}:{bucket}`;
 * recuperação fecha a condição (SYNC_RECOVERED emite INFO novo).
 */
import type { Db } from '../db/index.js';
import { emitEvent, closeCondition } from '../db/outbox.js';

export type StaleBucket = 'OK' | 'WARNING' | 'HIGH' | 'CRITICAL';

const GRACE_MS = 6 * 3600_000;
const MIN_DATA_AGE_MS = 24 * 3600_000;

interface StalenessInput {
  itemPublicId: string;
  lastHarvestAt: string | null; // ISO
  dataThrough: string | null; // MAX(date) das transações
  nextAutoSyncAt: string | null;
  itemStatus: string;
}

export function evaluateStaleness(db: Db, input: StalenessInput, nowMs: number = Date.now()): StaleBucket {
  const now = nowMs;

  const harvestAgeMs = input.lastHarvestAt ? now - Date.parse(input.lastHarvestAt) : Number.POSITIVE_INFINITY;
  const dataAgeMs = input.dataThrough ? now - Date.parse(input.dataThrough) : Number.POSITIVE_INFINITY;

  let overdue = false;
  if (input.nextAutoSyncAt) {
    const deadline = Date.parse(input.nextAutoSyncAt) + GRACE_MS;
    overdue = !input.lastHarvestAt || Date.parse(input.lastHarvestAt) < deadline;
  } else {
    // Sem auto-sync informado: cai para status/erro + idade do dado
    overdue = input.itemStatus !== 'UPDATED';
  }

  const bucket: StaleBucket =
    !(overdue && dataAgeMs >= MIN_DATA_AGE_MS) && harvestAgeMs < Number.POSITIVE_INFINITY
      ? 'OK'
      : dataAgeMs >= 168 * 3600_000
        ? 'CRITICAL'
        : dataAgeMs >= 72 * 3600_000
          ? 'HIGH'
          : dataAgeMs >= MIN_DATA_AGE_MS
            ? 'WARNING'
            : 'OK';

  applyStaleness(db, input.itemPublicId, bucket);
  return bucket;
}

/** Aplica o bucket, emite/fecha eventos na mesma transação. */
export function applyStaleness(db: Db, itemPublicId: string, bucket: StaleBucket): void {
  const tx = db.transaction(() => {
    db.prepare('UPDATE items SET stale_bucket = ? WHERE public_id = ?').run(bucket === 'OK' ? null : bucket, itemPublicId);

    if (bucket === 'OK') {
      // Fecha o episódio ativo, se existir, e registra recuperação INFO
      let anyClosed = closeCondition(db, activeDedupKey(itemPublicId));
      // dedup keys por bucket também devem fechar
      for (const b of ['WARNING', 'HIGH', 'CRITICAL'] as const) {
        const c = closeCondition(db, `sync-stale:${itemPublicId}:${b}`);
        anyClosed = anyClosed || c;
      }
      if (anyClosed) {
        emitEvent(db, {
          eventType: 'SYNC_RECOVERED',
          severity: 'INFO',
          dedupKey: `sync-recovered:${itemPublicId}`,
          payload: { itemPublicId },
        });
      }
      return;
    }

    const sev = bucket === 'WARNING' ? 'WARNING' : bucket === 'HIGH' ? 'HIGH' : 'CRITICAL';
    emitEvent(db, {
      eventType: 'SYNC_STALE',
      severity: sev,
      dedupKey: `sync-stale:${itemPublicId}:${bucket}`,
      payload: { itemPublicId, bucket, policyVersion: 'STALE_POLICY_V1' },
    });
  });
  tx();
}

function activeDedupKey(itemPublicId: string): string {
  return `sync-stale:${itemPublicId}:`;
}
