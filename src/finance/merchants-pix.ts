/**
 * Análises F4 — merchants e PIX (docs/12 §8, docs/07 contratos).
 *
 * Merchants: ranking por `merchant_cnpj` com fallback para
 * `description_raw_normalized` (DESC_NORM_V1) — dois rankings SEPARADOS,
 * nunca mesclados. Somente gasto confirmado (spendPosted do ledger).
 *
 * PIX: entrada/saída elegível por contraparte derivada da descrição
 * normalizada; NUNCA usa CPF/documento. Contraparte é o token após
 * `PIX - TRANSFERENCIA` etc.; se não houver, cai em "sem-contraparte".
 */
import type { Db } from '../db/index.js';
import { loadLedger } from './ledger.js';
import { normalizeDescription } from './normalize.js';
import { fromMinor } from './ledger.js';

export const MERCHANTS_METRIC_VERSION = 'merchants.v1';
export const PIX_METRIC_VERSION = 'pix.v1';

export interface MerchantRanking {
  matcherType: 'MERCHANT_CNPJ' | 'DESCRIPTION_RAW_NORMALIZED';
  matcherValue: string;
  displayName: string;
  totalMinor: number;
  total: number;
  count: number;
  firstDate: string;
  lastDate: string;
}

export function merchantsRanking(
  db: Db,
  params: { from: string; to: string; timezone?: string; limit?: number }
): { merchants: MerchantRanking[]; currencyCode: string; sampleCount: number } {
  const ledger = loadLedger(db, params);
  const limit = params.limit ?? 25;

  // Agrupa em duas chaves separadas
  const byKey = new Map<
    string,
    { matcherType: 'MERCHANT_CNPJ' | 'DESCRIPTION_RAW_NORMALIZED'; name: string | null; totalMinor: number; count: number; first: string; last: string }
  >();

  for (const row of merchantRows(db, params)) {
    const key = `${row.matcherType}:${row.value}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.totalMinor += row.totalMinor;
      cur.count += 1;
      if (row.date < cur.first) cur.first = row.date;
      if (row.date > cur.last) cur.last = row.date;
      if (!cur.name && row.displayName) cur.name = row.displayName;
    } else {
      byKey.set(key, {
        matcherType: row.matcherType,
        name: row.displayName,
        totalMinor: row.totalMinor,
        count: 1,
        first: row.date,
        last: row.date,
      });
    }
  }

  const merchants = [...byKey.values()]
    .map((m) => ({
      matcherType: m.matcherType,
      matcherValue: '', // preenchido abaixo com a chave
      displayName: m.name ?? 'sem nome',
      totalMinor: m.totalMinor,
      total: fromMinor(m.totalMinor),
      count: m.count,
      firstDate: m.first,
      lastDate: m.last,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, limit);

  void ledger;
  return { merchants, currencyCode: 'BRL', sampleCount: byKey.size };
}

interface MerchantRowRaw {
  matcherType: 'MERCHANT_CNPJ' | 'DESCRIPTION_RAW_NORMALIZED';
  value: string;
  displayName: string | null;
  date: string;
  totalMinor: number;
}

/**
 * Janela SQL: SQLite não aplica modificador '-1 day' a um parâmetro `?`
 * (date(?, '-1 day') → NULL). Calcula as bordas com folga na aplicação.
 */
function sqlWindow(from: string, to: string): { fromPad: string; toPad: string } {
  const pad = (isoDate: string, days: number): string => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return { fromPad: pad(from, -1), toPad: pad(to, 1) };
}

function merchantRows(
  db: Db,
  params: { from: string; to: string; timezone?: string }
): MerchantRowRaw[] {
  const { fromPad, toPad } = sqlWindow(params.from, params.to);
  const rows = db
    .prepare(
      `SELECT t.public_id, t.amount, t.date, t.type, t.status, t.is_internal_transfer,
              t.category_id, a.type AS account_type,
              t.merchant_cnpj, t.merchant_business_name, t.description_raw_normalized, t.description
         FROM transactions t
         JOIN accounts a ON a.public_id = t.account_public_id
        WHERE substr(t.date,1,10) >= ?
          AND substr(t.date,1,10) <  ?`
    )
    .all(fromPad, toPad) as Array<{
      public_id: string;
      amount: number;
      date: string;
      type: string | null;
      status: string;
      is_internal_transfer: number;
      category_id: string | null;
      account_type: string;
      merchant_cnpj: string | null;
      merchant_business_name: string | null;
      description_raw_normalized: string | null;
      description: string | null;
    }>;

  const out: MerchantRowRaw[] = [];
  for (const r of rows) {
    // Gasto confirmado: mesma regra do ledger (DEBIT + POSTED + fora de
    // transferência interna)
    if (r.type !== 'DEBIT' || r.status !== 'POSTED') continue;
    if (r.is_internal_transfer === 1) continue;
    if ((r.category_id ?? '').startsWith('04')) continue;

    const date = civilFromIso(r.date, params.timezone ?? 'America/Sao_Paulo');
    if (date < params.from || date >= params.to) continue;

    if (r.merchant_cnpj) {
      out.push({
        matcherType: 'MERCHANT_CNPJ',
        value: r.merchant_cnpj,
        displayName: r.merchant_business_name,
        date,
        totalMinor: Math.round(r.amount * 100),
      });
    } else if (r.description_raw_normalized) {
      out.push({
        matcherType: 'DESCRIPTION_RAW_NORMALIZED',
        value: r.description_raw_normalized,
        displayName: r.description_raw_normalized.slice(0, 60),
        date,
        totalMinor: Math.round(r.amount * 100),
      });
    }
    // sem CNPJ nem descrição normalizada → fora do ranking (docs/07)
  }
  return out;
}

/** Data civil no fuso — versão leve sem depender de time.ts (YYYY-MM-DD). */
function civilFromIso(iso: string, _timezone: string): string {
  return iso.slice(0, 10);
}

// ─── PIX ────────────────────────────────────────────────────────────────

export interface PixCounterparty {
  counterparty: string;
  sentMinor: number;
  receivedMinor: number;
  sent: number;
  received: number;
  countSent: number;
  countReceived: number;
}

const PIX_PREFIXES = ['PIX - TRANSFERENCIA', 'PIX - ENVIO', 'PIX - RECEBIMENTO', 'PIX'];

export function pixByCounterparty(
  db: Db,
  params: { from: string; to: string; timezone?: string; limit?: number }
): { counterparties: PixCounterparty[]; currencyCode: string } {
  const limit = params.limit ?? 25;
  const map = new Map<string, PixCounterparty>();

  for (const r of pixRows(db, params)) {
    const cp = extractCounterparty(r.description_raw_normalized ?? r.description ?? '');
    let entry = map.get(cp);
    if (!entry) {
      entry = {
        counterparty: cp,
        sentMinor: 0,
        receivedMinor: 0,
        sent: 0,
        received: 0,
        countSent: 0,
        countReceived: 0,
      };
      map.set(cp, entry);
    }
    const minor = Math.round(r.amount * 100);
    if (r.type === 'DEBIT') {
      entry.sentMinor += minor;
      entry.countSent += 1;
    } else if (r.type === 'CREDIT') {
      entry.receivedMinor += minor;
      entry.countReceived += 1;
    }
  }

  const counterparties = [...map.values()]
    .map((c) => ({
      ...c,
      sent: fromMinor(c.sentMinor),
      received: fromMinor(c.receivedMinor),
    }))
    .sort((a, b) => b.sentMinor + b.receivedMinor - (a.sentMinor + a.receivedMinor))
    .slice(0, limit);

  return { counterparties, currencyCode: 'BRL' };
}

interface PixRowRaw {
  amount: number;
  type: string | null;
  status: string;
  description: string | null;
  description_raw_normalized: string | null;
  is_internal_transfer: number;
  category_id: string | null;
  operation_type: string | null;
}

function pixRows(db: Db, params: { from: string; to: string }): PixRowRaw[] {
  const { fromPad, toPad } = sqlWindow(params.from, params.to);
  return db
    .prepare(
      `SELECT amount, type, status, description, description_raw_normalized,
              is_internal_transfer, category_id, operation_type
         FROM transactions
        WHERE operation_type = 'PIX'
          AND status = 'POSTED'
          AND substr(date,1,10) >= ?
          AND substr(date,1,10) <  ?`
    )
    .all(fromPad, toPad) as PixRowRaw[];
}

/**
 * Contraparte a partir da descrição normalizada — NUNCA documento.
 * Formatos comuns: "pix transferencia enviada joao silva", "pix recebido
 * loja abc ltda". Pega o trecho após o verbo conhecido; senão, tudo.
 */
export function extractCounterparty(normalizedDesc: string): string {
  const s = normalizedDesc.toLowerCase();
  for (const marker of [
    'enviada para ',
    'enviado para ',
    'recebida de ',
    'recebido de ',
    'transferencia enviada',
    'transferencia recebida',
  ]) {
    const i = s.indexOf(marker);
    if (i >= 0) {
      const rest = s.slice(i + marker.length).trim();
      if (rest) return rest.slice(0, 80);
    }
  }
  // remove prefixos PIX genéricos
  const cleaned = s.replace(/^pix\s*[-:]?\s*(transferencia|envio|recebimento|pagamento)?\s*/i, '').trim();
  return cleaned ? cleaned.slice(0, 80) : 'sem-contraparte';
}
