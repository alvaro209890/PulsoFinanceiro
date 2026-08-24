/**
 * Config central do PulsoFinanceiro.
 * Fonte: docs/03-infra-e-deploy.md e docs/11-seguranca-e-segredos.md
 *
 * Regra dura: segredo só via ambiente, nunca em arquivo versionado.
 * O backend é o ÚNICO componente que fala com api.pluggy.ai (docs/04 §1).
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`env obrigatória ausente: ${name}`);
  }
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`env ${name} inválida: esperado inteiro positivo`);
  }
  return Math.floor(n);
}

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  pluggyClientId: string;
  pluggyClientSecret: string;
  pluggyItemId: string | null;
  webhookBearerToken: string | null;
}

/** Lê config a cada chamada — permite testes com env isolada. */
export function getConfig(): AppConfig {
  return {
    port: optionalInt('PORT', 3040),
    host: process.env.HOST ?? '127.0.0.1',
    dbPath: process.env.DB_PATH ?? './data/pulso.sqlite',
    pluggyClientId: required('PLUGGY_CLIENT_ID'),
    pluggyClientSecret: required('PLUGGY_CLIENT_SECRET'),
    pluggyItemId: process.env.PLUGGY_ITEM_ID || null,
    webhookBearerToken: process.env.PLUGGY_WEBHOOK_BEARER_TOKEN || null,
  };
}
