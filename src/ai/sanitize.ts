/**
 * Sanitização e redação rigorosa de PII para IA — docs/10-camada-ia.md.
 *
 * Bloqueia e limpa: CPF, números de cartão/conta, telefones, e-mails, chaves de segredo
 * e strings longas que possam conter dumps ou instruções maliciosas.
 */

// Regex para padrões de documento e identificação sensível
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ_RE = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const CARD_RE = /\b(?:\d{4}[ -]?){3}\d{4}\b|\b\d{13,19}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?(?:9\d{4}|\d{4})[-.\s]?\d{4}\b/g;
const SECRET_RE = /\b(?:sk-[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,})\b/gi;

/**
 * Remove/mascara qualquer PII de uma string antes de enviar para LLM.
 */
export function sanitizeTextForAI(text: string): string {
  if (!text) return '';
  return text
    .replace(SECRET_RE, '[SEGREDO_REMOVIDO]')
    .replace(CPF_RE, '[CPF_REMOVIDO]')
    .replace(CNPJ_RE, '[CNPJ_REMOVIDO]')
    .replace(CARD_RE, '[CARTAO_REMOVIDO]')
    .replace(EMAIL_RE, '[EMAIL_REMOVIDO]')
    .replace(PHONE_RE, '[TELEFONE_REMOVIDO]')
    .trim();
}

/**
 * Sanitiza recursivamente objetos e arrays antes de empacotar no prompt JSON.
 */
export function sanitizeObjectForAI<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return sanitizeTextForAI(obj) as unknown as T;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObjectForAI(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Ignora chaves explicitamente sensíveis
      const keyLower = k.toLowerCase();
      if (
        keyLower.includes('password') ||
        keyLower.includes('secret') ||
        keyLower.includes('token') ||
        keyLower.includes('apikey') ||
        keyLower.includes('documentnumber') ||
        keyLower.includes('cardnumber') ||
        keyLower.includes('accountnumber')
      ) {
        continue;
      }
      cleaned[k] = sanitizeObjectForAI(v);
    }
    return cleaned as T;
  }
  return obj;
}
