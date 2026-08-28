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
import { upsertAccount, upsertTransaction, replaceCreditLimits } from '../db/upserts.js';
import { upsertBills } from '../db/bills.js';
import { matchBillPayments } from '../db/billMatch.js';
import { analyzeRecurrences } from '../finance/recurrences.js';
import { normalizeCnpj, normalizeDescription } from '../finance/normalize.js';
import {
  ensureCategoriesFor,
  newCategoryState,
  resolveCategory,
  syncCategories,
  type CategorySyncState,
} from './categories.js';
import { captureDailySnapshots } from '../db/snapshots.js';
import { evaluatePaceEvent, evaluateCardAndRecurrenceEvents } from '../finance/events.js';
import { bumpDataRevision } from '../finance/envelope.js';

export interface SyncResult {
  runId: string;
  kind: 'daily' | 'full';
  pagesFetched: number;
  txsUpserted: number;
  billsUpserted: number;
  billMatches: number;
  recurrences: number;
  categoriesSynced: number;
  /** Transações que citaram categoria fora do catálogo. */
  categoryDrift: number;
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

    // 2. Taxonomia ANTES das transações: `transactions.category_id` tem FK
    //    para `categories` e um catálogo vazio derruba o ciclo inteiro.
    const categoriesSynced = await syncCategories(db, client);
    const categoryState = newCategoryState(db);

    // 3. Contas → upsert
    const accounts = await client.getAccounts(itemId);
    const accountIds: Array<{ external: string; public: string; type: string }> = [];
    for (const a of accounts) {
      const publicId = upsertAccount(db, {
        externalId: a.id,
        itemPublicId: itemIdToPublicId(db, itemId),
        type: a.type,
        subtype: a.subtype,
        label: deriveLabel(a),
        balance: a.balance,
        currency: a.currencyCode,
        closingBalance: a.subtype === "SAVINGS_ACCOUNT" ? (a.balance ?? null) : (a.bankData?.closingBalance ?? null),
        credit: a.creditData
          ? {
              level: a.creditData.level,
              brand: a.creditData.brand,
              creditLimit: a.creditData.creditLimit,
              availableCreditLimit: a.creditData.availableCreditLimit,
              balanceDueDate: a.creditData.balanceDueDate,
              balanceCloseDate: a.creditData.balanceCloseDate,
              minimumPayment: a.creditData.minimumPayment,
              status: a.creditData.status,
            }
          : null,
      });
      if (a.creditData) {
        replaceCreditLimits(db, publicId, a.creditData.disaggregatedCreditLimits);
      }
      accountIds.push({ external: a.id, public: publicId, type: a.type });
    }

    // 4. Transações conta por conta, cursor até esgotar
    let pagesFetched = 0;
    let txsUpserted = 0;
    for (const acc of accountIds) {
      let page: PluggyTransactionPage = await client.firstTransactionPage(acc.external);
      for (;;) {
        pagesFetched += 1;
        if (pagesFetched > MAX_PAGES_HARD_LIMIT) {
          throw new Error(`CURSOR_LOOP: excedido ${MAX_PAGES_HARD_LIMIT} páginas`);
        }
        // Categoria nova da Pluggy ressincroniza o catálogo uma vez por ciclo.
        await ensureCategoriesFor(db, client, page.results, categoryState);
        for (const raw of page.results) {
          txsUpserted += applyTransaction(db, acc.public, raw, categoryState);
        }
        if (!page.next) break;
        page = await client.nextTransactionPage(page.next);
      }
    }

    // 5. Faturas do cartão (F3): a fatura é a fonte da obrigação aberta e do
    //    pareamento de pagamento; sem ela o snapshot cairia no fallback.
    let billsUpserted = 0;
    for (const acc of accountIds) {
      if (acc.type !== 'CREDIT') continue;
      const bills = await client.getBills(acc.external);
      billsUpserted += upsertBills(db, acc.public, bills).bills;
    }

    db.prepare(
      `UPDATE sync_runs SET finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), ok=1,
       pages_fetched=?, txs_upserted=? WHERE id=?`
    ).run(pagesFetched, txsUpserted, runId);

    // Fechamento do harvest no MESMO commit que confirma as métricas
    // (docs/09 §4.1, docs/12 F2/F3): pareamento de pagamento de fatura,
    // recorrências, fotografia do dia, eventos determinísticos e revisão.
    let billMatches = 0;
    let recurrences = 0;
    const closeRun = db.transaction(() => {
      billMatches = matchBillPayments(db).matched;
      recurrences = analyzeRecurrences(db).seriesPersisted;
      captureDailySnapshots(db, { syncRunId: runId });
      evaluatePaceEvent(db);
      evaluateCardAndRecurrenceEvents(db);
      bumpDataRevision(db);
    });
    closeRun();

    return {
      runId, kind, pagesFetched, txsUpserted, billsUpserted, billMatches, recurrences,
      categoriesSynced, categoryDrift: categoryState.drift, ok: true,
    };
  } catch (err) {
    const code = err instanceof Error ? err.message.slice(0, 60) : 'UNKNOWN';
    db.prepare(
      `UPDATE sync_runs SET finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), ok=0, error_code=? WHERE id=?`
    ).run(code, runId);
    return {
      runId, kind, pagesFetched: 0, txsUpserted: 0, billsUpserted: 0, billMatches: 0,
      recurrences: 0, categoriesSynced: 0, categoryDrift: 0, ok: false, errorCode: code,
    };
  }
}

function applyTransaction(
  db: Db,
  accountPublicId: string,
  raw: unknown,
  categoryState: CategorySyncState
): number {
  const t = raw as Record<string, unknown>;
  const externalId = typeof t['id'] === 'string' ? t['id'] : null;
  const amount = typeof t['amount'] === 'number' ? t['amount'] : null;
  const date = typeof t['date'] === 'string' ? t['date'] : null;
  const statusRaw = t['status'];
  if (!externalId || amount === null || !date || (statusRaw !== 'POSTED' && statusRaw !== 'PENDING')) {
    return 0; // registro fora do contrato é ignorado e contabilizado como não aplicado
  }
  const merchant = t['merchant'] as Record<string, unknown> | null | undefined;
  const cardMeta = t['creditCardMetadata'] as Record<string, unknown> | null | undefined;
  let catId = resolveCategory(strOrNull(t['categoryId']), categoryState);
  const rawDesc = String(strOrNull(t['descriptionRaw']) ?? strOrNull(t['description']) ?? '');
  if (rawDesc.includes('DEPARTAMENTO DE ÁGUA') && (!catId || catId.startsWith('04'))) {
    catId = '17020001';
  } else if (rawDesc.includes('Recarga - TIM') && (!catId || catId.startsWith('04'))) {
    catId = '07010000';
  } else if (rawDesc.includes('SEFAZ MT') && (!catId || catId.startsWith('04'))) {
    catId = '15000000';
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
    categoryId: catId,
    balanceAfter: typeof t['balance'] === 'number' ? t['balance'] : null,
    orderTiebreak: typeof t['order'] === 'number' ? t['order'] : null,
    rawJsonSanitized: JSON.stringify(sanitizeDeep(t)),
    // `creditCardMetadata.cardNumber` existe no payload e não é lido aqui:
    // número de cartão nunca é persistido (docs/09 §5.2).
    billForecastDate: strOrNull(cardMeta?.['billForecastDate']),
    payeeMcc: typeof cardMeta?.['payeeMCC'] === 'number' ? (cardMeta['payeeMCC'] as number) : null,
    merchantCnpj: normalizeCnpj(merchant?.['cnpj']),
    merchantBusinessName: strOrNull(merchant?.['businessName']),
    descriptionRawNormalized: normalizeDescription(
      strOrNull(t['descriptionRaw']) ?? strOrNull(t['description'])
    ),
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
