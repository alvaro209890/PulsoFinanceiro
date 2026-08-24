/**
 * Cliente Pluggy — contrato medido de docs/04-integracao-pluggy.md.
 *
 * Regras implementadas (§3 e §6):
 * - uma única API key em memória, renovada 10 min antes de expirar;
 * - renovação protegida por promise compartilhada (sem /auth concorrente);
 * - 401 → invalida cache, renova UMA vez e repete UMA vez; segundo 401 falha;
 * - paginação: primeira URL = endpoint + ?accountId=...; seguintes SEMPRE
 *   endpoint + response.next; next precisa começar com '?'; nunca decodificar
 *   ou fabricar cursor; next ausente/null encerra;
 * - endpoint legado GET /transactions é proibido (HTTP 410 no tenant);
 * - parâmetros aceitos: accountId, after, createdAtFrom, ids (+dateFrom/dateTo
 *   liberados pela ADR-026 como otimização).
 */

const PLUGGY_BASE = 'https://api.pluggy.ai';
const TRANSACTIONS_ENDPOINT = `${PLUGGY_BASE}/v2/transactions`;
/** Renova quando faltarem 10 minutos para expirar. */
const RENEW_AHEAD_MS = 10 * 60 * 1000;

export interface PluggyItem {
  status: string;
  executionStatus: string | null;
  lastUpdatedAt: string | null;
  nextAutoSyncAt: string | null;
  consentExpiresAt: string | null;
}

export interface PluggyAccount {
  id: string;
  type: string;
  subtype: string | null;
  name: string | null;
  marketingName: string | null;
  balance: number | null;
  currencyCode: string | null;
  /** So o que a metrica usa: nada de agencia, conta, titular ou cartao. */
  bankData: { closingBalance: number | null; automaticallyInvestedBalance: number | null } | null;
  creditData: {
    level: string | null;
    brand: string | null;
    creditLimit: number | null;
    availableCreditLimit: number | null;
    balanceDueDate: string | null;
    balanceCloseDate: string | null;
    minimumPayment: number | null;
    status: string | null;
    disaggregatedCreditLimits: Array<{
      creditLineLimitType: string | null;
      consolidationType: string | null;
      isLimitFlexible: boolean | null;
      usedAmount: number | null;
      limitAmount: number | null;
      availableAmount: number | null;
      customizedLimitAmount: number | null;
      currencyCode: string | null;
    }>;
  } | null;
}

/** Fatura como `/bills` devolve (medido no tenant em 24/08/2026). */
export interface PluggyBill {
  id: string;
  dueDate: string;
  billClosingDate: string | null;
  totalAmount: number;
  totalAmountCurrencyCode: string | null;
  minimumPaymentAmount: number | null;
  allowsInstallments: boolean | null;
  financeCharges: Array<{
    id: string | null;
    type: string;
    amount: number;
    currencyCode: string | null;
    additionalInfo: string | null;
  }>;
  payments: Array<{
    id: string | null;
    valueType: string | null;
    paymentDate: string | null;
    paymentMode: string | null;
    amount: number;
    currencyCode: string | null;
  }>;
}

export interface PluggyTransactionPage {
  results: unknown[];
  next: string | null;
}

export class PluggyError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly errorCode: string,
    readonly requestId?: string
  ) {
    super(message);
    this.name = 'PluggyError';
  }
}

interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

export class PluggyClient {
  private apiKey: string | null = null;
  private apiKeyExpiresAtMs = 0;
  private renewalPromise: Promise<void> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
    /** Injetável para testes. */
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Garante API key válida; renovando proativamente perto do vencimento. */
  async ensureApiKey(): Promise<string> {
    const remaining = this.apiKeyExpiresAtMs - this.now();
    if (this.apiKey && remaining > RENEW_AHEAD_MS) return this.apiKey;
    if (!this.renewalPromise) {
      this.renewalPromise = this.renew().finally(() => {
        this.renewalPromise = null;
      });
    }
    await this.renewalPromise;
    if (!this.apiKey) throw new PluggyError('renovação não produziu apiKey', null, 'AUTH_NO_KEY');
    return this.apiKey;
  }

  private async renew(): Promise<void> {
    const res = await this.fetchImpl(`${PLUGGY_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
    });
    if (!res.ok) {
      throw new PluggyError('falha de autenticação', res.status, `AUTH_HTTP_${res.status}`);
    }
    const body = (await res.json()) as { apiKey?: string };
    if (!body.apiKey) {
      throw new PluggyError('resposta de auth sem apiKey', res.status, 'AUTH_NO_KEY');
    }
    this.apiKey = body.apiKey;
    this.apiKeyExpiresAtMs = readJwtExpMs(body.apiKey, this.now());
  }

  /**
   * GET com X-API-KEY; diante de 401 renova uma vez e repete uma vez.
   * Segundo 401 encerra o ciclo (docs/04 §3.5).
   */
  private async getAuthorized(pathOrUrl: string): Promise<unknown> {
    const key = await this.ensureApiKey();
    let res = await this.fetchImpl(pathOrUrl, { headers: { 'X-API-KEY': key } });
    if (res.status === 401) {
      // Invalida o cache explicitamente para forçar renovação real (docs/04 §3.5).
      this.apiKey = null;
      this.apiKeyExpiresAtMs = 0;
      const fresh = await this.ensureApiKey();
      res = await this.fetchImpl(pathOrUrl, { headers: { 'X-API-KEY': fresh } });
      if (res.status === 401) {
        throw new PluggyError('401 persistente após renovação', 401, 'CREDENTIAL_INVALID');
      }
    }
    if (!res.ok) {
      const requestId = res.headers.get('pluggy-request-id') ?? undefined;
      throw new PluggyError(`HTTP ${res.status} em ${safeLabel(pathOrUrl)}`, res.status, `HTTP_${res.status}`, requestId);
    }
    return res.json();
  }

  async getItem(itemId: string): Promise<PluggyItem> {
    const body = (await this.getAuthorized(`${PLUGGY_BASE}/items/${itemId}`)) as Record<string, unknown>;
    return {
      status: String(body['status'] ?? ''),
      executionStatus: strOrNull(body['executionStatus']),
      lastUpdatedAt: strOrNull(body['lastUpdatedAt']),
      nextAutoSyncAt: strOrNull(body['nextAutoSyncAt']),
      consentExpiresAt: strOrNull(body['consentExpiresAt']),
    };
  }

  async getAccounts(itemId: string): Promise<PluggyAccount[]> {
    const body = (await this.getAuthorized(`${PLUGGY_BASE}/accounts?itemId=${encodeURIComponent(itemId)}`)) as {
      results?: Array<Record<string, unknown>>;
    };
    return (body.results ?? []).map((a) => {
      const bank = a['bankData'] as Record<string, unknown> | null | undefined;
      const credit = a['creditData'] as Record<string, unknown> | null | undefined;
      return {
        id: String(a['id']),
        type: String(a['type']),
        subtype: strOrNull(a['subtype']),
        name: strOrNull(a['name']),
        marketingName: strOrNull(a['marketingName']),
        balance: numOrNull(a['balance']),
        currencyCode: strOrNull(a['currencyCode']),
        bankData: bank
          ? {
              closingBalance: numOrNull(bank['closingBalance']),
              automaticallyInvestedBalance: numOrNull(bank['automaticallyInvestedBalance']),
            }
          : null,
        creditData: credit
          ? {
              level: strOrNull(credit['level']),
              brand: strOrNull(credit['brand']),
              creditLimit: numOrNull(credit['creditLimit']),
              availableCreditLimit: numOrNull(credit['availableCreditLimit']),
              balanceDueDate: strOrNull(credit['balanceDueDate']),
              balanceCloseDate: strOrNull(credit['balanceCloseDate']),
              minimumPayment: numOrNull(credit['minimumPayment']),
              status: strOrNull(credit['status']),
              // `identificationNumber` e `additionalCards[].number` existem no
              // payload e NAO sao lidos aqui: numero de cartao nao entra.
              disaggregatedCreditLimits: Array.isArray(credit['disaggregatedCreditLimits'])
                ? (credit['disaggregatedCreditLimits'] as Array<Record<string, unknown>>).map((d) => ({
                    creditLineLimitType: strOrNull(d['creditLineLimitType']),
                    consolidationType: strOrNull(d['consolidationType']),
                    isLimitFlexible: typeof d['isLimitFlexible'] === 'boolean' ? d['isLimitFlexible'] : null,
                    usedAmount: numOrNull(d['usedAmount']),
                    limitAmount: numOrNull(d['limitAmount']),
                    availableAmount: numOrNull(d['availableAmount']),
                    customizedLimitAmount: numOrNull(d['customizedLimitAmount']),
                    currencyCode: strOrNull(d['limitAmountCurrencyCode'] ?? d['currencyCode']),
                  }))
                : [],
            }
          : null,
      };
    });
  }

  /**
   * Faturas do cartao. A paginacao de `/bills` e por pagina, diferente da de
   * transacoes (docs/09 5.3) e nao vaza para o frontend.
   */
  async getBills(accountId: string): Promise<PluggyBill[]> {
    const out: PluggyBill[] = [];
    let page = 1;
    for (;;) {
      const body = (await this.getAuthorized(
        `${PLUGGY_BASE}/bills?accountId=${encodeURIComponent(accountId)}&page=${page}`
      )) as { results?: Array<Record<string, unknown>>; totalPages?: number; page?: number };
      for (const b of body.results ?? []) out.push(toBill(b));
      const totalPages = typeof body.totalPages === 'number' ? body.totalPages : 1;
      if (page >= totalPages || page >= 24) break;
      page += 1;
    }
    return out;
  }

  /**
   * Primeira página das transações de uma conta.
   * `params` só aceita as chaves do contrato medido; qualquer outra chave é bug.
   */
  async firstTransactionPage(
    accountId: string,
    params: { createdAtFrom?: string; dateFrom?: string; dateTo?: string } = {}
  ): Promise<PluggyTransactionPage> {
    const qs = new URLSearchParams({ accountId });
    if (params.createdAtFrom) qs.set('createdAtFrom', params.createdAtFrom);
    if (params.dateFrom) qs.set('dateFrom', params.dateFrom);
    if (params.dateTo) qs.set('dateTo', params.dateTo);
    return this.fetchTransactionPage(TRANSACTIONS_ENDPOINT, `?${qs.toString()}`);
  }

  /**
   * Página seguinte: recebe exatamente response.next da página anterior.
   * Validações de docs/04 §6: começa com '?', host fixo api.pluggy.ai via
   * reconstrução a partir do ENDPOINT canônico (nunca URL absoluta do payload).
   */
  async nextTransactionPage(nextQuery: string): Promise<PluggyTransactionPage> {
    return this.fetchTransactionPage(TRANSACTIONS_ENDPOINT, nextQuery);
  }

  private async fetchTransactionPage(endpoint: string, query: string): Promise<PluggyTransactionPage> {
    if (!query.startsWith('?')) {
      throw new PluggyError('cursor inválido: next deve começar com "?"', null, 'CURSOR_INVALID');
    }
    if (query.includes('//')) {
      throw new PluggyError('cursor inválido: query não pode conter URL', null, 'CURSOR_INVALID');
    }
    const body = (await this.getAuthorized(endpoint + query)) as {
      results?: unknown[];
      next?: string | null;
    };
    const next = body.next ?? null;
    if (next !== null && !next.startsWith('?')) {
      throw new PluggyError('response.next inesperado (não é query string)', null, 'CURSOR_INVALID');
    }
    return { results: body.results ?? [], next };
  }

  async getCategories(): Promise<Array<{ id: string; description: string; descriptionTranslated: string; parentId: string | null }>> {
    const body = (await this.getAuthorized(`${PLUGGY_BASE}/categories`)) as {
      results?: Array<Record<string, unknown>>;
    };
    return (body.results ?? []).map((c) => ({
      id: String(c['id']),
      description: String(c['description'] ?? ''),
      descriptionTranslated: String(c['descriptionTranslated'] ?? c['description'] ?? ''),
      parentId: strOrNull(c['parentId']),
    }));
  }
}

/** Lê exp do JWT sem registrar o token (docs/04 §3.2). */
export function readJwtExpMs(jwt: string, nowMs: number): number {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) {
    // Sem formato JWT utilizável: trata como curta e força renovação no próximo uso.
    return nowMs;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : nowMs;
  } catch {
    return nowMs;
  }
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toBill(b: Record<string, unknown>): PluggyBill {
  const charges = Array.isArray(b['financeCharges'])
    ? (b['financeCharges'] as Array<Record<string, unknown>>)
    : [];
  const payments = Array.isArray(b['payments'])
    ? (b['payments'] as Array<Record<string, unknown>>)
    : [];
  return {
    id: String(b['id']),
    dueDate: String(b['dueDate'] ?? ''),
    billClosingDate: strOrNull(b['billClosingDate']),
    totalAmount: numOrNull(b['totalAmount']) ?? 0,
    totalAmountCurrencyCode: strOrNull(b['totalAmountCurrencyCode']),
    minimumPaymentAmount: numOrNull(b['minimumPaymentAmount']),
    allowsInstallments: typeof b['allowsInstallments'] === 'boolean' ? b['allowsInstallments'] : null,
    financeCharges: charges.map((c) => ({
      id: strOrNull(c['id']),
      type: String(c['type'] ?? 'UNKNOWN'),
      amount: numOrNull(c['amount']) ?? 0,
      currencyCode: strOrNull(c['currencyCode']),
      additionalInfo: strOrNull(c['additionalInfo']),
    })),
    payments: payments.map((p) => ({
      id: strOrNull(p['id']),
      valueType: strOrNull(p['valueType']),
      paymentDate: strOrNull(p['paymentDate']),
      paymentMode: strOrNull(p['paymentMode']),
      amount: numOrNull(p['amount']) ?? 0,
      currencyCode: strOrNull(p['currencyCode']),
    })),
  };
}

/** Label seguro para erro: caminho sem query sensível (docs/04 §11). */
function safeLabel(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}
