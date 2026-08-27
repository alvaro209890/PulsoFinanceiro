/**
 * Marcos determinísticos do Catalisador da Virada (docs/15 §2.3 e §3).
 *
 * Marco é consequência de métrica já provada — nunca sorte, nunca aposta
 * (ADR-024). O cálculo roda NO BACKEND e é idempotente por
 * (milestone_key, period): reprocessar o mesmo mês não duplica linha
 * (UNIQUE já definido na migração 0001). A UI apenas marca celebrated_at.
 *
 * Marcos implementados:
 *  - MONTH_BELOW_AVG_3M: mês FECHADO abaixo da média dos 3 anteriores.
 *  - CATEGORY_STREAK_3M: 3 meses seguidos sem estourar categoria.
 *  - RESERVE_GOAL_HIT:   meta de reserva (mediana derivada) batida no mês.
 */
import type { Db } from '../db/index.js';
import { loadLedger, sumSpendPosted } from './ledger.js';
import { savingsEvolution } from './savings.js';

export const MILESTONES_METRIC_VERSION = 'milestones.v1';

export type MilestoneKey =
  | 'MONTH_BELOW_AVG_3M'
  | 'CATEGORY_STREAK_3M'
  | 'RESERVE_GOAL_HIT';

/** Chaves canônicas — o cliente nunca inventa chave. */
export const KNOWN_KEYS: readonly string[] = [
  'MONTH_BELOW_AVG_3M',
  'CATEGORY_STREAK_3M',
  'RESERVE_GOAL_HIT',
];

const LABELS: Record<string, string> = {
  MONTH_BELOW_AVG_3M: 'mês fechado abaixo da média dos 3 anteriores',
  CATEGORY_STREAK_3M: '3 meses seguidos sem estourar nenhuma categoria',
  RESERVE_GOAL_HIT: 'meta de reserva atingida',
};

export function milestoneLabel(key: string): string {
  return LABELS[key] ?? key;
}

function ulid(): string {
  // ULID-like: timestamp de 10 chars Crockford + aleatório de 16.
  const enc = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let ts = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = enc[ts % 32] + timePart;
    ts = Math.floor(ts / 32);
  }
  let rand = '';
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) rand += enc[b % 32];
  return `${timePart}${rand}`;
}

/** Últimos N meses fechados (o mês corrente NÃO entra), em ordem crescente. */
function closedMonths(count: number): string[] {
  const out: string[] = [];
  const now = new Date();
  // Mês corrente só conta como fechado no dia seguinte ao seu fim; na prática,
  // consideramos fechado o mês anterior ao corrente para trás.
  for (let i = 1; i <= count; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out.reverse(); // crescente
}

function monthRange(month: string): { from: string; to: string } {
  const [yStr, mStr] = month.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { from: `${month}-01`, to: `${ny}-${String(nm).padStart(2, '0')}-01` };
}

/** Gasto confirmado elegível (mesma definição do overview) num mês. */
function monthSpend(db: Db, month: string): number {
  const { from, to } = monthRange(month);
  const ledger = loadLedger(db, { from, to });
  return sumSpendPosted(ledger.rows);
}

/**
 * Avalia todos os marcos elegíveis e grava os novos (INSERT OR IGNORE).
 * Idempotente: rodar duas vezes não muda nada. Retorna os eventos gravados
 * nesta execução e o total acumulado.
 */
export function computeMilestones(db: Db): { inserted: number; total: number } {
  const months = closedMonths(6); // janela de avaliação
  if (months.length < 4) return { inserted: 0, total: countAll(db) };

  let inserted = 0;

  // ── 1) MONTH_BELOW_AVG_3M ────────────────────────────────────────────────
  // Para cada mês fechado com pelo menos 3 anteriores na janela.
  for (let i = 3; i < months.length; i += 1) {
    const target = months[i]!;
    const base = months.slice(i - 3, i);
    const spends = base.map((m) => monthSpend(db, m));
    const avg = spends.reduce((a, v) => a + v, 0) / 3;
    if (avg <= 0) continue; // sem histórico comparável → nenhum marco é inventado
    const spend = monthSpend(db, target);
    if (spend > 0 && spend < avg) {
      inserted += insertOnce(db, 'MONTH_BELOW_AVG_3M', target);
    }
  }

  // ── 2) CATEGORY_STREAK_3M ────────────────────────────────────────────────
  // Para cada tripla consecutiva de meses fechados: se em cada mês do trio
  // nenhuma categoria raiz passou o próprio teto histórico (média dos meses
  // ANTERIORES à tríade, por simplicidade a média móvel dos 3 anteriores),
  // registra o marco no terceiro mês do trio.
  for (let i = 5; i < months.length; i += 1) {
    const trio = [months[i - 2]!, months[i - 1]!, months[i]!];
    const history = months.slice(Math.max(0, i - 5), i - 2);
    if (history.length < 3) continue;
    const ok = trio.every((target) => {
      const base = history;
      const caps = capsByRoot(db, base); // média histórica por raiz
      const spent = spentByRoot(db, target);
      for (const [root, cap] of caps) {
        if ((spent.get(root) ?? 0) > cap * 1.10) return false; // 10% de tolerância
      }
      return true;
    });
    if (ok) inserted += insertOnce(db, 'CATEGORY_STREAK_3M', trio[2]!);
  }

  // ── 3) RESERVE_GOAL_HIT ──────────────────────────────────────────────────
  // Meta derivada (mediana do residual, docs/09 §poupança) batida num mês
  // fechado. Usa a MESMA engine de poupança da aba Análises — zero regra nova.
  const savings = savingsEvolution(db, { months: 12 });
  if (savings.goalMonthly > 0) {
    const closedSet = new Set(months);
    for (const m of savings.months) {
      if (!closedSet.has(m.month)) continue; // só mês fechado celebra
      if ((m.residualVariation ?? -Infinity) >= savings.goalMonthly) {
        inserted += insertOnce(db, 'RESERVE_GOAL_HIT', m.month);
      }
    }
  }

  return { inserted, total: countAll(db) };
}

/** Teto por categoria-raiz: média do gasto confirmado da raiz nos meses-base. */
function capsByRoot(db: Db, months: string[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const m of months) {
    const { from, to } = monthRange(m);
    const ledger = loadLedger(db, { from, to });
    for (const r of ledger.rows) {
      if (!r.spendPosted) continue;
      sums.set(r.rootCode, (sums.get(r.rootCode) ?? 0) + r.amountMinor);
    }
  }
  const caps = new Map<string, number>();
  for (const [root, total] of sums) caps.set(root, Math.round(total / months.length));
  return caps;
}

function spentByRoot(db: Db, month: string): Map<string, number> {
  const { from, to } = monthRange(month);
  const ledger = loadLedger(db, { from, to });
  const map = new Map<string, number>();
  for (const r of ledger.rows) {
    if (!r.spendPosted) continue;
    map.set(r.rootCode, (map.get(r.rootCode) ?? 0) + r.amountMinor);
  }
  return map;
}

function insertOnce(db: Db, key: string, period: string): number {
  const info = db
    .prepare(
      `INSERT INTO milestone_events (id, milestone_key, period, computed_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(milestone_key, period) DO NOTHING`
    )
    .run(ulid(), key, period);
  return info.changes;
}

function countAll(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM milestone_events').get() as { n: number };
  return row.n;
}
