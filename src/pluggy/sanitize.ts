/**
 * Sanitização — a denylist canônica de docs/05-modelo-de-dados.md.
 *
 * Regra: o objeto inteiro da Pluggy passa por aqui antes de gerar
 * raw_json_sanitized. Campos de alto risco (número de conta/cartão, owner,
 * CPF/documento, identificadores em profundidade inesperada) são REMOVIDOS,
 * nunca ofuscados nem persistidos.
 */

const DENY_KEYS = new Set<string>([
  'number',
  'owner',
  'taxnumber',
  'documentnumber',
  'cpfcnpj',
  'cpf',
  'cnpj_value', // merchant.cnpj pode ficar; documento puro não — ver abaixo
]);

/** Substrings que denunciam chave sensível ondequer que apareçam. */
const DENY_SUBSTRINGS = [
  'document',
  'taxid',
  'fingerprint', // SOURCE_FINGERPRINT_V1 nunca sai do derivador local
];

export function sanitizeDeep(value: unknown): unknown {
  return walk(value, 0);
}

function walk(v: unknown, depth: number): unknown {
  if (depth > 12) return null; // proteção contra estruturas hostis
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isDeniedKey(k)) continue;
      out[k] = walk(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && looksLikeCpf(v)) return null;
  return v;
}

function isDeniedKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z]/g, '');
  // cnpj de merchant é permitido como coluna local (docs/04 §6), mas
  // documento dentro de paymentData (payer/receiver) é removido.
  if (norm === 'cnpj') return false;
  if (DENY_KEYS.has(norm)) return true;
  return DENY_SUBSTRINGS.some((s) => norm.includes(s));
}

/** Heurística conservadora: 11 dígitos isolados com padrão CPF. */
export function looksLikeCpf(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  // se o texto original contém mais conteúdo que os dígitos, provavelmente
  // não é um campo de documento dedicado; só removemos campos "puros".
  return digits === s.replace(/[.\-\s]/g, '');
}
