/**
 * Normalização determinística de texto e CNPJ — docs/05 §categorias
 * ("Unicode NFKC, caixa alta, trim, espaços repetidos reduzidos a um e
 * remoção somente de sufixos variáveis previamente testados") e docs/09
 * §6.1 (a chave de recorrência é CNPJ ou descrição normalizada).
 *
 * Números NÃO são removidos indiscriminadamente: parcela e estabelecimento
 * dependem deles. Só sufixos variáveis testados saem, e a versão do
 * algoritmo é explícita para que uma mudança futura seja rastreável.
 */

export const NORMALIZATION_VERSION = 'DESC_NORM_V1';

/**
 * Sufixos variáveis observados no tenant: numeração de parcela
 * (`PARCELA 3/12`, `3/12`) e data colada no fim (`08/2026`).
 * Removê-los junta a mesma cobrança recorrente em uma única série.
 */
const VARIABLE_SUFFIXES: readonly RegExp[] = [
  /\s+PARCELA\s+\d{1,2}\s*\/\s*\d{1,2}$/,
  /\s+\d{1,2}\s*\/\s*\d{1,2}$/,
  /\s+\d{2}\/\d{4}$/,
];

/** Descrição normalizada usada como chave estável de série. */
export function normalizeDescription(value: string | null | undefined): string | null {
  if (!value) return null;
  let out = value.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
  for (const re of VARIABLE_SUFFIXES) out = out.replace(re, '').trim();
  return out.length > 0 ? out : null;
}

/** CNPJ só com dígitos; qualquer coisa fora de 14 dígitos é descartada. */
export function normalizeCnpj(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  return digits.length === 14 ? digits : null;
}
