/**
 * Recorte temporal — docs/09 §2.3.
 *
 * Dia, mês, vencimento e comparação usam `America/Sao_Paulo`. Períodos têm
 * início inclusivo e fim EXCLUSIVO (docs/07 §convenções). Instantes vindos
 * da Pluggy são convertidos para data civil local antes de qualquer conta;
 * o backend nunca soma por UTC e depois rotula como dia local.
 */

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/** Allowlist fechada — timezone é escolha do contrato, não texto livre. */
export const TIMEZONE_ALLOWLIST: readonly string[] = [DEFAULT_TIMEZONE, 'UTC'];

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/**
 * Data civil local `YYYY-MM-DD` de um instante ISO. Valor que já é data
 * civil pura é devolvido como está: ele não carrega hora para reinterpretar.
 */
export function civilDate(value: string, timezone: string = DEFAULT_TIMEZONE): string {
  if (CIVIL_DATE_RE.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return formatter(timezone).format(d);
}

export function isCivilDate(value: string): boolean {
  return CIVIL_DATE_RE.test(value);
}

export function isMonth(value: string): boolean {
  return MONTH_RE.test(value);
}

/** Hoje em data civil local. */
export function today(timezone: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  return formatter(timezone).format(now);
}

/** Mês `YYYY-MM` → intervalo [from, to) em datas civis. */
export function monthRange(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const from = `${month}-01`;
  const nextYear = m === 12 ? year + 1 : year;
  const nextMonth = m === 12 ? 1 : m + 1;
  return { from, to: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01` };
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Soma meses a `YYYY-MM` (delta pode ser negativo). */
export function addMonths(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const total = year * 12 + (m - 1) + delta;
  const y2 = Math.floor(total / 12);
  const m2 = total % 12;
  return `${String(y2).padStart(4, '0')}-${String(m2 + 1).padStart(2, '0')}`;
}

export function daysInMonth(month: string): number {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

/** Soma dias a uma data civil, sem passar por timezone (aritmética de calendário). */
export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Quantidade de dias civis em [from, to). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Lista de datas civis de [from, to). */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Dia da semana civil: 1 = segunda … 7 = domingo (docs/09 §4.4). */
export function weekday(date: string): number {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return dow === 0 ? 7 : dow;
}

/** Dia do mês (1..31) de uma data civil. */
export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}
