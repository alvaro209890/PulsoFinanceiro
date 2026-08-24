/**
 * Agendador do harvest diário — docs/06 §6.
 *
 * Roda dentro do processo (sem cron externo na F1): calcula o próximo
 * horário, dorme e executa. O horário padrão é 04:30 local (fora do horário
 * de uso); configurável via HARVEST_HOUR/HARVEST_MINUTE.
 */
import type { Db } from '../db/index.js';
import type { PluggyClient } from '../pluggy/client.js';
import { syncItem } from './sync.js';
import { evaluateStaleness } from './staleness.js';

export interface HarvestSchedulerHandle {
  stop: () => void;
  runNow: () => Promise<void>;
}

export function startHarvestScheduler(
  db: Db,
  client: PluggyClient,
  itemId: string,
  opts: { hour?: number; minute?: number } = {}
): HarvestSchedulerHandle {
  const hour = opts.hour ?? Number(process.env.HARVEST_HOUR ?? 4);
  const minute = opts.minute ?? Number(process.env.HARVEST_MINUTE ?? 30);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const msUntilNext = (): number => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    await syncItem(db, client, itemId, 'daily');
    refreshStaleness(db, client, itemId).catch(() => {});
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await run().catch(() => {});
      schedule();
    }, msUntilNext());
    timer.unref?.();
  };
  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runNow: run,
  };
}

/** Recalcula staleness do item com o estado atual do banco + item remoto. */
export async function refreshStaleness(db: Db, client: PluggyClient, externalItemId: string): Promise<string> {
  const item = db.prepare('SELECT public_id FROM items WHERE external_id = ?').get(externalItemId) as
    | { public_id: string }
    | undefined;
  if (!item) return 'OK';

  const remote = await client.getItem(externalItemId).catch(() => null);
  const lastRun = db
    .prepare(`SELECT MAX(finished_at) AS t FROM sync_runs WHERE ok = 1`)
    .get() as { t: string | null };
  const dataThrough = db
    .prepare('SELECT MAX(date) AS d FROM transactions')
    .get() as { d: string | null };

  return evaluateStaleness(db, {
    itemPublicId: item.public_id,
    lastHarvestAt: lastRun.t ?? null,
    dataThrough: dataThrough.d ?? null,
    nextAutoSyncAt: remote?.nextAutoSyncAt ?? null,
    itemStatus: remote?.status ?? 'UNKNOWN',
  });
}
