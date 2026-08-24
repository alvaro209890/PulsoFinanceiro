/**
 * Job de sincronização — docs/06-job-de-sincronizacao.md.
 *
 * Estratégia base (F1): harvest diário conta por conta com paginação por
 * cursor até next=null; reconciliação full pagina todo o conjunto. Upsert
 * idempotente por transaction.id. Nunca força update do Item (docs/04 §4).
 */
import type { Db } from '../db/index.js';
import { ulid } from 'ulid';
import type { PluggyClient, PluggyTransactionPage } from '../pluggy/client.js';
import { sanitizeDeep } from '../pluggy/sanitize.js';
import { upsertAccount, upsertTransaction } from '../db/upserts.js';
import { captureDailySnapshots } from '../db/snapshots.js';
import { evaluatePaceEvent } from '../finance/events.js';
import { bumpDataRevision } from '../finance/envelope.js';

export interface SyncResult {
  runId: string;
  kind: 'daily' | 'full';
  pagesFetched: number;
  txsUpserted: number;
  ok: boolean;
  errorCode?: string;
}

const MAX_PAGES_HARD_LIMIT = 100; // trava de segurança contra loop de cursor

export async function syncItem(
  db: Db,
  client: PluggyClient,
  itemId: string,
  kind: 'daily' | 'full'
): Promise<SyncResult> {
  const runId = ulid();
  db.prepare('INSERT INTO sync_runs (id, started_at, kind) VALUES (?, strftime(?,\'now\'), ?)')
    .run(runId, '%Y-%m-%dT%H:%M:%fZ', kind);

  try {
    // 1. Estado do item (GET /items/{id} é a primeira operação — docs/04 §4)
    await client.getItem(itemId);

    // 2. Contas → upsert
    const accounts = await client.getAccounts(itemId);
    const accountIds: Array<{ external: string; public: string }> = [];
    for (const a of accounts) {
      const publicId = upsertAccount(db, {
        externalId: a.id,
        itemPublicId: itemIdToPublicId(db, itemId),
        type: a.type,
        subtype: a.subtype,
        label: deriveLabel(a),
        balance: a.balance,
        currency: a.currencyCode,
      });
      accountIds.push({ external: a.id, public: publicId });
    }

    // 3. Transações conta por conta, cursor até esgotar
    let pagesFetched = 0;
    let txsUpserted = 0;
    for (const acc of accountIds) {
      let page: PluggyTransactionPage = await client.firstTransactionPage(acc.external);
      for (;;) {
        pagesFetched += 1;
        if (pagesFetched > MAX_PAGES_HARD_LIMIT) {
          throw new Error(`CURSOR_LOOP: excedido ${MAX_PAGES_HARD_LIMIT} páginas`);
        }
        for (const raw of page.results) {
          txsUpserted += applyTransaction(db, acc.public, raw);
        }
        if (!page.next) break;
        page = await client.nextTransactionPage(page.next);
      }
    }

    db.prepare(
      `UPDATE sync_runs SET finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), ok=1,
       pages_fetched=?, txs_upserted=? WHERE id=?`
    ).run(pagesFetched, txsUpserted, runId);

    // F2: fotografia do dia, avaliação determinística do ritmo e revisão de
    // dados no MESMO commit que confirma a métrica (docs/09 §4.1, docs/12 F2).
    const closeRun = db.transaction(() => {
      captureDailySnapshots(db, { syncRunId: runId });
      evaluatePaceEvent(db);
      bumpDataRevision(db);
    });
    closeRun();

    return { runId, kind, pagesFetched, txsUpserted, ok: true };
  } catch (err) {
    const code = err instanceof Error ? err.message.slice(0, 60) : 'UNKNOWN';
    db.prepare(
      `UPDATE sync_runs SET finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), ok=0, error_code=? WHERE id=?`
    ).run(code, runId);
    return { runId, kind, pagesFetched: 0, txsUpserted: 0, ok: false, errorCode: code };
  }
}

function applyTransaction(db: Db, accountPublicId: string, raw: unknown): number {
  const t = raw as Record<string, unknown>;
  const externalId = typeof t['id'] === 'string' ? t['id'] : null;
  const amount = typeof t['amount'] === 'number' ? t['amount'] : null;
  const date = typeof t['date'] === 'string' ? t['date'] : null;
  const statusRaw = t['status'];
  if (!externalId || amount === null || !date || (statusRaw !== 'POSTED' && statusRaw !== 'PENDING')) {
    return 0; // registro fora do contrato é ignorado e contabilizado como não aplicado
  }
  const { inserted } = upsertTransaction(db, {
    externalId,
    accountPublicId,
    amount: Math.abs(amount),
    currency: String(t['currencyCode'] ?? 'BRL'),
    date,
    status: statusRaw,
    type: t['type'] === 'DEBIT' || t['type'] === 'CREDIT' ? t['type'] : null,
    operationType: strOrNull(t['operationType']),
    description: strOrNull(t['description']),
    categoryId: strOrNull(t['categoryId']),
    balanceAfter: typeof t['balance'] === 'number' ? t['balance'] : null,
    orderTiebreak: typeof t['order'] === 'number' ? t['order'] : null,
    rawJsonSanitized: JSON.stringify(sanitizeDeep(t)),
  });
  return inserted ? 1 : 1; // conta ambos: upsertado = inserido ou atualizado
}

/** Item público local: cria na primeira sincronização. */
function itemIdToPublicId(db: Db, externalItemId: string): string {
  const row = db.prepare('SELECT public_id FROM items WHERE external_id = ?').get(externalItemId) as
    | { public_id: string }
    | undefined;
  if (row) return row.public_id;
  const publicId = ulid();
  db.prepare('INSERT INTO items (public_id, external_id, status) VALUES (?,?,?)').run(publicId, externalItemId, 'UPDATED');
  return publicId;
}

/** Rótulo local derivado de tipo/subtipo sem número de conta (docs/04 §5). */
function deriveLabel(a: { type: string; subtype: string | null; name: string | null }): string {
  const cleanName = (a.name ?? '').replace(/\d{4,}/g, '').trim(); // remove sequências que parecem conta
  const sub = a.subtype === 'CHECKING_ACCOUNT' ? 'Conta corrente'
    : a.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança'
    : a.subtype === 'CREDIT_CARD' ? 'Cartão'
    : (a.subtype ?? a.type);
  return cleanName ? `${sub} · ${cleanName}` : sub;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
