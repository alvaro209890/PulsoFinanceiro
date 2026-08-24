# 07 — API interna

## Princípio

Toda métrica exibida no frontend ou consumida pelo Hermes nasce nesta API. Componentes podem formatar data, moeda e cor; não podem recomputar gasto, patrimônio, projeção, anomalia ou severidade.

Base humana: `/api/v1`.

Base futura para agentes: `/api/agent/v1`.

Todos os exemplos abaixo são fictícios e usam placeholders.

## Convenções

- JSON em `camelCase` na borda; nomes SQL ficam em `snake_case`.
- Datas civis: `YYYY-MM-DD`.
- Instantes: ISO 8601 UTC com `Z`.
- Valores monetários: número decimal no JSON e moeda ISO 4217 ao lado; o backend usa representação decimal segura, nunca ponto flutuante para somar.
- Timezone padrão: `America/Sao_Paulo`.
- Períodos têm início inclusivo e fim exclusivo nos contratos internos.
- Toda coleção tem ordenação declarada e estável.
- Toda resposta agregada de métricas financeiras informa no topo `computedAt`, `dataThrough`, `period`, `currencyCode`, `counts`, `metricVersion` e `quality`; não cria um segundo relógio concorrente como `asOf`. `metricId` aparece apenas no objeto métrico que ele identifica, nunca em evento operacional.
- Quando um objeto possui mais de um valor citável, ele traz um mapa fechado `metricIds` de nome do campo para ID; um escalar estruturado usa `metricId`. `counts` no envelope é metadado diagnóstico de cobertura, não fonte narrativa: se um count precisar ser citado, o backend também o projeta como métrica identificada.
- Em DTOs e paths humanos/agentes de contas e transações, `id` e `accountId` significam os respectivos `public_id` locais (ULID opaco). As chaves da Pluggy só entram pela superfície de integração e nunca aparecem em resposta ou path de consumo.
- Pagamento de fatura só é excluído de gasto quando há vínculo persistido em `transaction_bill_payment_matches`; frontend e IA nunca tentam refazer esse match.

## Segurança por superfície

| Superfície | Controle |
|---|---|
| `/health/live`, `/health/ready` | sem dados, próprios para probe local |
| `/api/v1/*` | identidade humana obrigatória: JWT Cloudflare Access validado no origin; fallback B = asserção assinada por proxy autenticador Tailscale externo |
| `/api/webhooks/pluggy` | host dedicado, Bearer, WAF, rate limit, corpo limitado e inbox idempotente |
| `/api/agent/v1/*` | token de serviço com hash local e escopos explícitos |

Não há cookies, sessões, senhas ou tabela de usuários do PulsoFinanceiro.

Nas rotas humanas, identidade significa JWT do Access integralmente validado **no origin**: assinatura/`kid`, `iss`, `aud`, `exp`, `nbf` e e-mail allowlisted. `Protect with Access` no Tunnel é defesa adicional, não alternativa. Se Access se tornar inviável, o fallback B exige asserção curta assinada por proxy autenticador externo da tailnet; o PulsoFinanceiro não cria token/sessão humana. Loopback, Tunnel, IP Tailscale ou header de e-mail isolado nunca contam como identidade. Exposição humana aberta foi descartada, inclusive para GETs.

## Envelope de sucesso agregado

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"records": 0},
  "metricVersion": "monthly-spend.v1",
  "quality": "complete",
  "data": {}
}
```

## Envelope de erro

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Parâmetros inválidos.",
    "requestId": "<REQUEST_ID>",
    "details": [
      {"field": "month", "reason": "Formato esperado: YYYY-MM"}
    ]
  }
}
```

O erro nunca inclui stack, SQL, payload Pluggy, header, segredo, path de `.env`, descrição real ou PII.

## Rotas operacionais

### `GET /health/live`

Parâmetros: nenhum.

Identidade: nenhuma; contrato sem dados, destinado à probe local. A rota não testa SQLite, Pluggy nem OpenRouter.

Resposta `200` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "status": "LIVE"
}
```

Erros desta rota: `503 PROCESS_DEGRADED` somente durante encerramento fatal já detectado; timeout ou ausência de resposta também significa falha de liveness.

### `GET /health/ready`

Parâmetros: nenhum.

Identidade: nenhuma; contrato sem dados, destinado à probe local. Os nomes dos checks são fechados e não revelam paths.

Resposta `200` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "status": "READY",
  "checks": {
    "sqlite": "READY",
    "migrations": "READY",
    "scheduler": "READY"
  }
}
```

Erros desta rota: `503 DEPENDENCY_NOT_READY` quando SQLite, migrations ou scheduler não estiverem prontos; a resposta conserva apenas o nome fechado do check e seu estado.

### `POST /api/webhooks/pluggy`

Parâmetros:

| Local | Nome | Obrigatório | Regra |
|---|---|---:|---|
| header | `Authorization` | sim | `Bearer <token>` comparado em tempo constante |
| header | `Content-Type` | sim | `application/json` |
| body | `event` | sim | enum da `webhook_inbox.event_type` |
| body | `eventId` | sim | identificador externo tratado como string opaca |
| body | `itemId` | condicional | obrigatório em `item/updated` e em todo `transactions/*`; deve ser o único Item configurado; nunca retornado |
| body | `accountId` | condicional | obrigatório em todo `transactions/*`; o worker valida que pertence ao `itemId`; nunca retornado |
| body | `transactionIds` | condicional | array não vazio de strings opacas em `transactions/updated` e `transactions/deleted` |
| body | links/timestamp de criação | condicional | em `transactions/created`, ao menos um link V2 permitido ou `transactionsCreatedAtFrom` válido; link legado isolado aciona o fallback seguro da conta |
| body | `triggeredBy` | não | valor informativo sanitizado |

Identidade: Bearer exclusivo do webhook, WAF e rate limit no host dedicado; não usa Cloudflare Access, cookie nem HMAC não documentado.

Request (exemplo fictício; todos os identificadores são placeholders):

```json
{
  "event": "transactions/created",
  "eventId": "<PLUGGY_EVENT_ID>",
  "itemId": "<PLUGGY_ITEM_ID>",
  "accountId": "<PLUGGY_ACCOUNT_ID>",
  "triggeredBy": "SYNC"
}
```

Resposta `202` após persistência idempotente na inbox (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "accepted": true,
  "duplicate": false
}
```

Evento repetido pelo mesmo `eventId` também retorna `202`, com `duplicate: true`, sem criar segunda linha.

Erros desta rota: `401 WEBHOOK_TOKEN_INVALID` para Bearer ausente/inválido; `413 WEBHOOK_BODY_TOO_LARGE` antes do parse; `422 WEBHOOK_EVENT_UNSUPPORTED` para evento fora da allowlist; `422 WEBHOOK_ENVELOPE_INVALID` para campo condicional ausente, array vazio ou Item fora do escopo; `503 WEBHOOK_INBOX_UNAVAILABLE` quando a persistência durável não puder ser confirmada. Envelope inválido não entra na inbox; a reconciliação agendada continua cobrindo o evento perdido.

## Rotas humanas

### `GET /api/v1/dashboard/overview`

Parâmetros:

| Nome | Obrigatório | Regra |
|---|---|---|
| `from` | não | data; padrão = início do mês corrente |
| `to` | não | data exclusiva; máximo de 366 dias após `from` |
| `timezone` | não | allowlist; padrão `America/Sao_Paulo` |

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima; nenhum cookie ou sessão local.

Resposta (exemplo fictício; todo ID é placeholder local):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"accounts": 3, "alerts": 1},
  "metricVersion": "dashboard-overview.v1",
  "quality": "complete",
  "data": {
    "netWorth": {"amount": 8450.25, "changeAmount": 310.15, "changePercent": 3.81, "currencyCode": "BRL", "metricIds": {"amount": "net-worth:2026-01-15", "changeAmount": "net-worth-change:2026-01", "changePercent": "net-worth-change-percent:2026-01"}},
    "netWorthSeries": [{"date": "2026-01-15", "amount": 8450.25, "quality": "complete", "metricId": "net-worth:2026-01-15"}],
    "netWorthComponents": [
      {"kind": "BANK_BALANCE", "accountId": "<LOCAL_ACCOUNT_ID>", "amount": 9770.65, "quality": "complete", "metricId": "net-worth-bank-component:<LOCAL_ACCOUNT_ID>:2026-01-15"},
      {"kind": "OPEN_BILL", "accountId": "<LOCAL_CREDIT_ACCOUNT_ID>", "amount": -1320.40, "dueDate": "2026-02-10", "source": "BILLS", "quality": "complete", "metricIds": {"amount": "net-worth-bill-component:<LOCAL_CREDIT_ACCOUNT_ID>:2026-01-15", "dueDate": "bill-due:<LOCAL_CREDIT_ACCOUNT_ID>:2026-02-10"}}
    ],
    "monthSpend": {"posted": 1320.40, "pending": 86.30, "currencyCode": "BRL", "metricIds": {"posted": "month-spend:2026-01", "pending": "month-spend-pending:2026-01"}},
    "forecast": {"amount": 2410.00, "rangeLow": 2230.00, "rangeHigh": 2620.00, "currencyCode": "BRL", "metricIds": {"amount": "month-forecast:2026-01", "rangeLow": "month-forecast-low:2026-01", "rangeHigh": "month-forecast-high:2026-01"}},
    "mostExpensiveDay": {"date": "2026-01-12", "amount": 244.30, "transactionRefs": ["<LOCAL_TRANSACTION_A>"], "metricIds": {"date": "most-expensive-day-date:2026-01", "amount": "most-expensive-day-amount:2026-01"}},
    "dailySpend": [{"date": "2026-01-12", "amount": 244.30, "coverage": "complete", "metricId": "daily-spend:2026-01-12"}],
    "weekdayAverages": [{"weekday": 1, "amount": 83.20, "coveredOccurrences": 2, "metricIds": {"amount": "weekday-average:1:2026-01", "coveredOccurrences": "weekday-covered-occurrences:1:2026-01"}}],
    "alerts": [
      {"type": "CREDIT_LIMIT_BAND_CHANGED", "severity": "HIGH", "eventId": "<EVENT_ID>"}
    ]
  }
}
```

Erros desta rota: `400 VALIDATION_ERROR` para período invertido, intervalo acima de 366 dias ou timezone fora da allowlist; `503 DATA_STALE` quando nenhum snapshot válido sustenta o overview.

### `GET /api/v1/analytics/monthly-pace`

Parâmetros:

| Nome | Obrigatório | Regra |
|---|---:|---|
| `month` | sim | `YYYY-MM` |
| `comparisonMonths` | não | inteiro de 3 a 12; padrão 6, sem configuração persistente |

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"sampleMonths": 6, "dailyPoints": 15, "expectedRecurrences": 1},
  "metricVersion": "monthly-pace.v1",
  "quality": "complete",
  "data": {
    "confirmedSpend": {"amount": 1320.40, "currencyCode": "BRL", "metricId": "month-spend:2026-01"},
    "pendingSpend": {"amount": 86.30, "currencyCode": "BRL", "metricId": "month-spend-pending:2026-01"},
    "historicalSameDaysAverage": {"amount": 1190.20, "currencyCode": "BRL", "metricId": "same-days-average:2026-01:6"},
    "historicalSameDaysMin": {"amount": 980.10, "currencyCode": "BRL", "metricId": "same-days-min:2026-01:6"},
    "historicalSameDaysMax": {"amount": 1440.80, "currencyCode": "BRL", "metricId": "same-days-max:2026-01:6"},
    "paceRatio": {"value": 1.1094, "metricId": "month-pace-ratio:2026-01:6"},
    "forecast": {
      "amount": 2410.00,
      "rangeLow": 2230.00,
      "rangeHigh": 2620.00,
      "currencyCode": "BRL",
      "confidence": "MEDIUM",
      "reasonCodes": ["SHORT_CURRENT_MONTH_COVERAGE"],
      "components": {"confirmed": 1320.40, "eligiblePending": 86.30, "nonRecurringPaceFuture": 943.40, "expectedRecurrencesNotYetCharged": 59.90, "remainingDays": 16},
      "metricIds": {"amount": "month-forecast:2026-01", "rangeLow": "month-forecast-low:2026-01", "rangeHigh": "month-forecast-high:2026-01", "confirmed": "month-forecast-confirmed:2026-01", "eligiblePending": "month-forecast-pending:2026-01", "nonRecurringPaceFuture": "month-forecast-pace-future:2026-01", "expectedRecurrencesNotYetCharged": "month-forecast-recurrences:2026-01", "remainingDays": "month-forecast-remaining-days:2026-01"}
    },
    "daily": [{"date": "2026-01-15", "confirmed": 42.90, "historicalAverage": 38.10, "metricIds": {"confirmed": "daily-confirmed:2026-01-15", "historicalAverage": "daily-historical-average:2026-01-15:6"}}],
    "expectedRecurrences": [{"recurrenceId": "<LOCAL_RECURRENCE_ID>", "amount": 59.90, "expectedDate": "2026-01-20", "metricIds": {"amount": "expected-recurrence-amount:<LOCAL_RECURRENCE_ID>", "expectedDate": "expected-recurrence-date:<LOCAL_RECURRENCE_ID>"}}]
  }
}
```

Erros desta rota: `400 VALIDATION_ERROR` para mês inválido ou `comparisonMonths` fora da faixa; `422 METRIC_NOT_AVAILABLE` quando o mês antecede toda a cobertura local. Histórico curto retorna `200` com `quality: "insufficient"`, não erro.

### `GET /api/v1/analytics/categories`

Parâmetros:

| Nome | Obrigatório | Regra |
|---|---:|---|
| `from`, `to` | não | datas; ambas omitidas = mês corrente; `to` exclusivo; máximo 366 dias |
| `rootCode` | não | dois dígitos ou `99` |
| `includePending` | não | boolean; padrão `false` |

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta em gasto efetivo decrescente e depois `categoryId` crescente (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"categories": 1, "transactions": 4},
  "metricVersion": "categories-rollup.v1",
  "quality": "complete",
  "data": {
    "total": {"postedAmount": 245.30, "pendingAmount": 0, "metricIds": {"postedAmount": "categories-posted-total:2026-01", "pendingAmount": "categories-pending-total:2026-01"}},
    "categories": [{
      "categoryId": "08000000",
      "rootCode": "08",
      "label": "Compras",
      "postedAmount": 245.30,
      "pendingAmount": 0,
      "previousComparableAmount": 210.00,
      "deltaAmount": 35.30,
      "deltaPercent": 16.8095,
      "newInPeriod": false,
      "monthlySeries": [{"month": "2026-01", "comparableThroughDay": 15, "postedAmount": 245.30, "metricIds": {"comparableThroughDay": "category-month-comparable-through-day:08000000:2026-01", "postedAmount": "category-month:08000000:2026-01:day-15"}}],
      "metricIds": {"postedAmount": "category-posted:08000000:2026-01", "pendingAmount": "category-pending:08000000:2026-01", "previousComparableAmount": "category-previous-comparable:08000000:2026-01", "deltaAmount": "category-delta:08000000:2026-01", "deltaPercent": "category-delta-percent:08000000:2026-01"},
      "children": [{"categoryId": "08040000", "label": "Vestuário", "postedAmount": 245.30, "metricId": "category-posted:08040000:2026-01"}]
    }]
  }
}
```

Quando a base anterior é zero, `deltaPercent` é `null` e `newInPeriod = true`. A soma das raízes e dos filhos é fechada pelo backend; “Sem categoria” e `99999999` (“Outros”) são grupos distintos.

Erros desta rota: `400 VALIDATION_ERROR` para período, boolean ou raiz inválidos; `422 METRIC_NOT_AVAILABLE` quando a taxonomia ainda não foi sincronizada.

### `GET /api/v1/analytics/merchants`

Parâmetros: `from` e `to` opcionais com padrão no mês corrente e limite de 366 dias; `limit` opcional de 1 a 50, padrão 20.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta em gasto decrescente (exemplo fictício; `merchantKey` é local e opaca):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"merchants": 1, "transactions": 3},
  "metricVersion": "merchant-spend.v1",
  "quality": "complete",
  "data": {
    "totalEligible": {"amount": 148.70, "currencyCode": "BRL", "metricId": "merchant-total-eligible:2026-01"},
    "otherMerchants": {"amount": 20.00, "transactionCount": 1, "metricIds": {"amount": "merchant-other-amount:2026-01", "transactionCount": "merchant-other-count:2026-01"}},
    "merchants": [{"merchantKey": "<LOCAL_MERCHANT_KEY>", "label": "Estabelecimento fictício", "identification": "CNPJ", "transactionCount": 3, "postedAmount": 128.70, "averageTicket": 42.90, "lastOccurrenceDate": "2026-01-14", "changePercent": 7.5, "transactionRefs": ["<LOCAL_TRANSACTION_ID>"], "metricIds": {"transactionCount": "merchant-count:<LOCAL_MERCHANT_KEY>:2026-01", "postedAmount": "merchant-posted:<LOCAL_MERCHANT_KEY>:2026-01", "averageTicket": "merchant-average-ticket:<LOCAL_MERCHANT_KEY>:2026-01", "lastOccurrenceDate": "merchant-last-date:<LOCAL_MERCHANT_KEY>:2026-01", "changePercent": "merchant-change:<LOCAL_MERCHANT_KEY>:2026-01"}}]
  }
}
```

Erros desta rota: `400 VALIDATION_ERROR` para período ou limite inválido; `422 METRIC_NOT_AVAILABLE` quando não há período comparável para a variação solicitada. A ausência de merchants no período retorna lista vazia.

### `GET /api/v1/analytics/pix`

Parâmetros: `from` e `to` opcionais com padrão no mês corrente e limite de 366 dias; `direction=ALL|IN|OUT`, padrão `ALL`; `limit` de 1 a 50, padrão 20.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta em valor absoluto decrescente (exemplo fictício; nenhuma chave PIX é devolvida):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"counterparties": 1, "transactions": 2},
  "metricVersion": "pix-counterparties.v1",
  "quality": "complete",
  "data": {
    "totals": {"sent": 75.00, "received": 120.00, "internalTransfers": 30.00, "metricIds": {"sent": "pix-sent:2026-01", "received": "pix-received:2026-01", "internalTransfers": "pix-internal:2026-01"}},
    "monthlyTrend": [{"month": "2026-01", "sent": 75.00, "received": 120.00, "metricIds": {"sent": "pix-sent:2026-01", "received": "pix-received:2026-01"}}],
    "counterparties": [{"counterpartyKey": "<LOCAL_COUNTERPARTY_KEY>", "label": "Contraparte fictícia", "direction": "OUT", "transactionCount": 2, "amount": 75.00, "medianTicket": 37.50, "lastDate": "2026-01-14", "metricIds": {"transactionCount": "pix-counterparty-count:<LOCAL_COUNTERPARTY_KEY>:2026-01", "amount": "pix-counterparty-amount:<LOCAL_COUNTERPARTY_KEY>:2026-01", "medianTicket": "pix-counterparty-median:<LOCAL_COUNTERPARTY_KEY>:2026-01", "lastDate": "pix-counterparty-last-date:<LOCAL_COUNTERPARTY_KEY>:2026-01"}}]
  }
}
```

Erros desta rota: `400 VALIDATION_ERROR` para período, direção ou limite inválidos; `422 METRIC_NOT_AVAILABLE` quando nenhuma transação tem sinal PIX identificável na cobertura local.

### `GET /api/v1/analytics/recurrences`

Parâmetros: `status=ACTIVE|DORMANT|RESUMED|ALL`, padrão `ALL`; `limit` de 1 a 100, padrão 50.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta em custo anualizado decrescente (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2025-02-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"recurrences": 1, "occurrences": 4},
  "metricVersion": "recurrences.v1",
  "quality": "complete",
  "data": {
    "annualizedTotal": {"amount": 718.80, "currencyCode": "BRL", "metricId": "recurrences-annualized-total:BRL"},
    "annualizedByCategory": [{"categoryId": "09000000", "amount": 718.80, "currencyCode": "BRL", "metricId": "recurrences-annualized-category:09000000:BRL"}],
    "recurrences": [{
      "id": "<LOCAL_RECURRENCE_ID>",
      "displayName": "Recorrência fictícia",
      "status": "RESUMED",
      "cadence": "MONTHLY",
      "typicalAmount": 59.90,
      "nextExpectedDate": "2026-02-05",
      "lastOccurrenceDate": "2026-01-05",
      "annualizedCost": 718.80,
      "regularityScore": 0.75,
      "amountStabilityScore": 0.91,
      "lastGapDays": 71,
      "resumedAt": "2026-01-05T12:00:00Z",
      "analysisVersion": "recurrence.v1",
      "confidence": "HIGH",
      "priceIncrease": {"detected": true, "baseAmount": 54.90, "currentAmount": 59.90, "increaseAmount": 5.00, "increasePercent": 9.1075, "windowSize": 4, "metricIds": {"baseAmount": "recurrence-price-base:<LOCAL_RECURRENCE_ID>", "currentAmount": "recurrence-price-current:<LOCAL_RECURRENCE_ID>", "increaseAmount": "recurrence-price-delta:<LOCAL_RECURRENCE_ID>", "increasePercent": "recurrence-price-percent:<LOCAL_RECURRENCE_ID>"}},
      "evidence": {"occurrenceCount": 4, "transactionRefs": ["<LOCAL_TRANSACTION_A>", "<LOCAL_TRANSACTION_B>"], "coverageComplete": true},
      "metricIds": {"typicalAmount": "recurrence-typical:<LOCAL_RECURRENCE_ID>", "nextExpectedDate": "recurrence-next-date:<LOCAL_RECURRENCE_ID>", "lastOccurrenceDate": "recurrence-last-date:<LOCAL_RECURRENCE_ID>", "annualizedCost": "recurrence-annualized:<LOCAL_RECURRENCE_ID>", "regularityScore": "recurrence-regularity:<LOCAL_RECURRENCE_ID>", "amountStabilityScore": "recurrence-stability:<LOCAL_RECURRENCE_ID>", "lastGapDays": "recurrence-gap-days:<LOCAL_RECURRENCE_ID>"}
    }]
  }
}
```

Os escores saem normalizados entre 0 e 1; o banco os persiste em basis points inteiros. `evidence.transactionRefs` contém somente `transactions.public_id` locais, e a API pode paginar a composição completa sem expor a chave Pluggy.

Não se afirma “sem uso”: a fonte bancária não contém telemetria de uso do serviço.

Erros desta rota: `400 VALIDATION_ERROR` para status ou limite inválidos; `422 METRIC_NOT_AVAILABLE` quando a cobertura contém menos de três ocorrências elegíveis para qualquer série.

### `GET /api/v1/analytics/anomalies`

Parâmetros: `from` e `to` opcionais com padrão no mês corrente e limite de 366 dias; `kind=DUPLICATE|LOG_ZSCORE|PRICE_INCREASE|ALL`, padrão `ALL`; `limit` de 1 a 100, padrão 50. `LOG_ZSCORE` é o z-score clássico calculado sobre `ln(1 + valor)`, não uma estatística robusta.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta por severidade e data decrescentes (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"anomalies": 2, "transactionsEvaluated": 42},
  "metricVersion": "anomalies.v1",
  "quality": "complete",
  "data": {
    "anomalies": [
      {"id": "<LOCAL_ANOMALY_ID>", "metricId": "anomaly:<LOCAL_ANOMALY_ID>", "kind": "DUPLICATE", "severity": "HIGH", "explanation": "Duas saídas fictícias têm mesmo valor e intervalo curto.", "transactionRefs": ["<LOCAL_TRANSACTION_A>", "<LOCAL_TRANSACTION_B>"], "evidence": {"absoluteAmount": 64.90, "intervalMinutes": 12, "metricIds": {"absoluteAmount": "duplicate-amount:<LOCAL_ANOMALY_ID>", "intervalMinutes": "duplicate-interval:<LOCAL_ANOMALY_ID>"}}},
      {"id": "<LOCAL_LOG_ZSCORE_ID>", "metricId": "anomaly:<LOCAL_LOG_ZSCORE_ID>", "kind": "LOG_ZSCORE", "severity": "WARNING", "explanation": "A saída fictícia ficou acima da faixa histórica da categoria.", "transactionRefs": ["<LOCAL_TRANSACTION_C>"], "evidence": {"currentAmount": 213.70, "sampleMeanLog": 4.08, "sampleStdDevLog": 0.33, "score": 3.37, "sampleCount": 24, "categoryId": "08000000", "distribution": [{"bucket": "0-50", "count": 11, "metricId": "log-zscore-bucket:<LOCAL_LOG_ZSCORE_ID>:0-50"}, {"bucket": "50-100", "count": 9, "metricId": "log-zscore-bucket:<LOCAL_LOG_ZSCORE_ID>:50-100"}, {"bucket": "100+", "count": 4, "metricId": "log-zscore-bucket:<LOCAL_LOG_ZSCORE_ID>:100-plus"}], "metricIds": {"currentAmount": "log-zscore-current:<LOCAL_LOG_ZSCORE_ID>", "sampleMeanLog": "log-zscore-mean:<LOCAL_LOG_ZSCORE_ID>", "sampleStdDevLog": "log-zscore-stddev:<LOCAL_LOG_ZSCORE_ID>", "score": "log-zscore-score:<LOCAL_LOG_ZSCORE_ID>", "sampleCount": "log-zscore-sample-count:<LOCAL_LOG_ZSCORE_ID>"}}}
    ]
  }
}
```

Erros desta rota: `400 VALIDATION_ERROR` para período, tipo ou limite inválidos; `422 METRIC_NOT_AVAILABLE` quando o detector selecionado não possui amostra mínima. Nenhum achado retorna lista vazia.

### `GET /api/v1/analytics/savings`

Parâmetros: `from` e `to` opcionais com padrão nos últimos seis meses civis, `to` exclusivo e máximo de 366 dias.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2025-08-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"balanceSnapshots": 6, "derivedTargets": 1},
  "metricVersion": "savings.v1",
  "quality": "partial",
  "data": {
    "balanceSeries": [{"date": "2026-01-15", "closingBalance": 3200.00, "automaticallyInvestedBalance": 450.00, "metricIds": {"closingBalance": "savings-closing-balance:2026-01-15", "automaticallyInvestedBalance": "savings-auto-invested:2026-01-15"}}],
    "balanceChange": {"amount": 300.00, "currencyCode": "BRL", "metricId": "savings-balance-change:2025-08:2026-02"},
    "internalContributions": {"amount": 150.00, "currencyCode": "BRL", "metricId": "savings-internal-contributions:2025-08:2026-02"},
    "internalWithdrawals": {"amount": 30.00, "currencyCode": "BRL", "metricId": "savings-internal-withdrawals:2025-08:2026-02"},
    "residualChange": {"amount": 180.00, "currencyCode": "BRL", "metricId": "savings-residual-change:2025-08:2026-02"},
    "estimatedYield": null,
    "derivedTargets": [{"rootCode": "11", "label": "Alimentos e bebidas", "referenceAmount": 437.60, "referenceMedian": 418.25, "currentAmount": 219.40, "projectionAmount": 402.10, "metricIds": {"referenceAmount": "derived-target-reference:11:2026-01", "referenceMedian": "derived-target-median:11:2026-01", "currentAmount": "derived-target-current:11:2026-01", "projectionAmount": "derived-target-projection:11:2026-01"}}],
    "discretionaryStreak": {"completeDays": 4, "through": "2026-01-14", "eligibleRootCodes": ["08", "09", "14", "21"], "breakingTransactionRefs": [], "calendar": [{"date": "2026-01-14", "state": "CLEAN", "eligiblePostedAmount": 0, "coverage": "complete", "metricId": "discretionary-day-spend:2026-01-14"}], "metricIds": {"completeDays": "discretionary-streak-days:2026-01-14", "through": "discretionary-streak-through:2026-01-14"}}
  }
}
```

`residualChange = balanceChange - internalContributions + internalWithdrawals`. A variação residual não é rotulada como rentabilidade; a aplicação automática permanece série separada.

Erros desta rota: `400 VALIDATION_ERROR` para período inválido; `422 METRIC_NOT_AVAILABLE` quando não existe snapshot inicial ou final. Cobertura incompleta retorna `200` com `quality: "partial"` e `estimatedYield: null`.

### `GET /api/v1/credit-card`

Parâmetros: `billMonth=YYYY-MM` opcional; ausente seleciona o ciclo corrente identificado pela API.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta (exemplo fictício; `accountId` é `accounts.public_id`):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"bills": 1, "financeCharges": 2, "categorizedCostTransactions": 2, "cardCreditsUnclassified": 1},
  "metricVersion": "credit-card.v1",
  "quality": "partial",
  "data": {
    "accountId": "<LOCAL_ACCOUNT_ID>",
    "limit": {"total": 5000.00, "available": 3100.00, "used": 1900.00, "usedPercent": 38.0, "band": "NORMAL", "metricIds": {"total": "credit-limit-total:<LOCAL_ACCOUNT_ID>", "available": "credit-limit-available:<LOCAL_ACCOUNT_ID>", "used": "credit-limit-used:<LOCAL_ACCOUNT_ID>", "usedPercent": "credit-limit-used-percent:<LOCAL_ACCOUNT_ID>"}, "components": []},
    "currentBill": {
      "cycle": "2026-02",
      "debitPosted": 1320.40,
      "debitPending": 86.30,
      "creditPosted": 120.00,
      "creditPending": 0,
      "matchedCardCredits": 100.00,
      "cardCreditUnclassified": 20.00,
      "observedNet": 1286.70,
      "dueDate": "2026-02-10",
      "daysUntilDue": 26,
      "quality": "partial",
      "categoryBreakdown": [{"categoryId": "08000000", "debitPosted": 245.30, "debitPending": 0, "metricIds": {"debitPosted": "current-bill-category-debit-posted:08000000:2026-02", "debitPending": "current-bill-category-debit-pending:08000000:2026-02"}}],
      "cycleUnassigned": {"transactionCount": 1, "absoluteAmount": 19.90, "metricIds": {"transactionCount": "current-bill-cycle-unassigned-count:2026-02", "absoluteAmount": "current-bill-cycle-unassigned-amount:2026-02"}},
      "metricIds": {"debitPosted": "current-bill-debit-posted:<LOCAL_ACCOUNT_ID>:2026-02", "debitPending": "current-bill-debit-pending:<LOCAL_ACCOUNT_ID>:2026-02", "creditPosted": "current-bill-credit-posted:<LOCAL_ACCOUNT_ID>:2026-02", "creditPending": "current-bill-credit-pending:<LOCAL_ACCOUNT_ID>:2026-02", "matchedCardCredits": "current-bill-matched-card-credits:<LOCAL_ACCOUNT_ID>:2026-02", "cardCreditUnclassified": "current-bill-card-credit-unclassified:<LOCAL_ACCOUNT_ID>:2026-02", "observedNet": "current-bill-observed-net:<LOCAL_ACCOUNT_ID>:2026-02", "dueDate": "bill-due:<LOCAL_ACCOUNT_ID>:2026-02-10", "daysUntilDue": "current-bill-days-until-due:<LOCAL_ACCOUNT_ID>:2026-02"}
    },
    "observedCreditCostsYear": {
      "financeCharges": {"amount": 24.50, "count": 2, "metricIds": {"amount": "credit-cost-finance-charges:2026", "count": "credit-cost-finance-charge-count:2026"}},
      "categoryTransactions": [
        {"categoryId": "15030000", "amount": 8.20, "count": 1, "metricIds": {"amount": "credit-cost-category:15030000:2026", "count": "credit-cost-category-count:15030000:2026"}},
        {"categoryId": "02020000", "amount": 6.30, "count": 1, "metricIds": {"amount": "credit-cost-category:02020000:2026", "count": "credit-cost-category-count:02020000:2026"}}
      ],
      "overlapStatus": "UNVERIFIED",
      "quality": "partial",
      "conservativeTotal": {"amount": 24.50, "rule": "MAX_SOURCE_TOTAL", "metricId": "credit-cost-conservative-total:2026"}
    },
    "history": [{"month": "2026-01", "dueDate": "2026-02-10", "totalAmount": 1320.40, "metricIds": {"dueDate": "bill-due:<LOCAL_ACCOUNT_ID>:2026-02-10", "totalAmount": "bill-total:<LOCAL_ACCOUNT_ID>:2026-01"}}]
  }
}
```

Enquanto `overlapStatus` for `UNVERIFIED`, `conservativeTotal` é o maior entre a soma de `financeCharges` e a soma das transações `POSTED` nas categorias `15030000`/`02020000`; os componentes sempre permanecem visíveis. Não há promessa de deduplicação até a sobreposição ser validada.

Erros desta rota: `400 VALIDATION_ERROR` para mês inválido; `404 RESOURCE_NOT_FOUND` quando não há conta `CREDIT/CREDIT_CARD`; `422 METRIC_NOT_AVAILABLE` quando limite ou ciclo não pode ser identificado sem inventar dado.

### `GET /api/v1/accounts`

Parâmetros: nenhum.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta em `displayName ASC, id ASC` (exemplo fictício; `id` é `accounts.public_id`):

```json
{
  "schemaVersion": "1.0",
  "data": [
    {"id": "<LOCAL_ACCOUNT_ID>", "type": "BANK", "subtype": "CHECKING_ACCOUNT", "displayName": "Conta fictícia", "currencyCode": "BRL", "snapshot": {"capturedAt": "2026-01-15T11:58:00Z", "balance": 3200.00}}
  ]
}
```

`number`, `owner`, `taxNumber`, número do cartão e IDs externos não existem no DTO.

Erros desta rota: `503 DATA_STALE` quando nenhuma fotografia válida existe; contas legitimamente vazias retornam `200` com `data: []`.

### `GET /api/v1/bills`

Parâmetros:

| Nome | Obrigatório | Regra |
|---|---:|---|
| `accountId` | sim | `accounts.public_id` local opaco de conta de crédito |
| `from`, `to` | não | vencimentos; padrão nos últimos 12 meses, `to` exclusivo, máximo 366 dias |

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta por `dueDate DESC, id DESC` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2025-02-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"bills": 1, "financeCharges": 1, "matchedPayments": 1},
  "metricVersion": "bills-history.v1",
  "quality": "complete",
  "data": [
    {
      "accountId": "<LOCAL_ACCOUNT_ID>",
      "dueDate": "2026-02-10",
      "closingDate": "2026-02-03",
      "totalAmount": 1320.40,
      "deltaAmount": 110.20,
      "minimumPaymentAmount": 198.06,
      "minimumPaymentPercent": 15.00,
      "currencyCode": "BRL",
      "allowsInstallments": true,
      "metricIds": {"dueDate": "bill-due:<LOCAL_ACCOUNT_ID>:2026-02-10", "closingDate": "bill-closing-date:<LOCAL_ACCOUNT_ID>:2026-02", "totalAmount": "bill-total:<LOCAL_ACCOUNT_ID>:2026-02", "deltaAmount": "bill-delta:<LOCAL_ACCOUNT_ID>:2026-02", "minimumPaymentAmount": "bill-minimum-payment:<LOCAL_ACCOUNT_ID>:2026-02", "minimumPaymentPercent": "bill-minimum-payment-percent:<LOCAL_ACCOUNT_ID>:2026-02"},
      "financeCharges": [{"type": "INTEREST", "amount": 12.50, "metricId": "bill-finance-charge:<LOCAL_ACCOUNT_ID>:2026-02:INTEREST"}],
      "providerPayments": [],
      "matchedPaymentTransactions": [{"transactionId": "<LOCAL_TRANSACTION_ID>", "role": "BANK_DEBIT", "confidence": "HIGH"}]
    }
  ]
}
```

A paginação da Pluggy não vaza ao frontend; a coleção já está normalizada.

Erros desta rota: `400 VALIDATION_ERROR` para conta ausente ou período inválido; `404 RESOURCE_NOT_FOUND` para conta local inexistente ou que não seja de crédito.

### `GET /api/v1/transactions`

Parâmetros:

| Nome | Regra |
|---|---|
| `from`, `to` | período local, máximo 366 dias |
| `accountId` | `accounts.public_id` local opaco opcional |
| `categoryRoot` | dois dígitos ou `99` |
| `status` | `POSTED`, `PENDING` ou `ALL` |
| `type` | `DEBIT`, `CREDIT` ou `ALL` |
| `cursor` | cursor local opaco |
| `limit` | 1–100; padrão 50 |

`from` e `to` são opcionais em conjunto; ambas omitidas selecionam o mês corrente, `to` é exclusivo e o intervalo máximo é 366 dias.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Ordenação: `date DESC`, `order DESC`, `id DESC`. O cursor codifica as três chaves e não é o cursor da Pluggy.

Resposta (exemplo fictício; todos os IDs e descrições são fictícios):

```json
{
  "schemaVersion": "1.0",
  "data": [
    {
      "id": "<LOCAL_TRANSACTION_ID>",
      "version": "<TRANSACTION_ETAG>",
      "description": "Compra fictícia",
      "date": "2026-01-14",
      "amount": 42.90,
      "currencyCode": "BRL",
      "type": "DEBIT",
      "status": "POSTED",
      "category": {"id": "08040000", "label": "Vestuário", "rootCode": "08"},
      "effectiveInternalTransfer": false,
      "billPaymentMatch": null,
      "cardCreditClassification": null,
      "categoryOverride": null
    }
  ],
  "nextCursor": "<CURSOR_LOCAL>"
}
```

No DTO, `id` é `transactions.public_id`. `billPaymentMatch`, quando não nulo, contém somente `role = BANK_DEBIT|CARD_CREDIT` e `confidence = HIGH|MEDIUM`; crédito de cartão não pareado usa `cardCreditClassification: "UNCLASSIFIED"` e degrada métricas dependentes para `quality: "partial"`. O DTO não inclui `raw_json_sanitized`, CPF, account/card number, tax number, ID da Pluggy nem payload de pagamento.

Erros desta rota: `400 VALIDATION_ERROR` para período, filtros, limite ou cursor malformado; `404 RESOURCE_NOT_FOUND` para `accountId` local inexistente; `409 CURSOR_SNAPSHOT_EXPIRED` quando o cursor aponta para uma visão local já invalidada.

### `PUT /api/v1/transactions/:id/category-override`

Parâmetros: path `id` obrigatório, `transactions.public_id` local opaco de transação existente; header `If-Match: "<TRANSACTION_ETAG>"` obrigatório, com o `version` recebido em `GET /api/v1/transactions`; body conforme abaixo. Não há query string.

Identidade: identidade humana da opção de borda aprovada. É uma das duas únicas escritas financeiras e só existe ao aceitar ou ajustar sugestão já contextualizada.

Request (exemplo fictício):

```json
{
  "categoryId": "08040000",
  "ruleScope": "DESCRIPTION_RAW_NORMALIZED"
}
```

`categoryId` deve existir na taxonomia sincronizada. `ruleScope` aceita somente `MERCHANT_CNPJ` ou `DESCRIPTION_RAW_NORMALIZED`, conforme os matchers do modelo de dados, e é escolhido por controle de um clique.

Resposta `200` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "data": {
    "transactionId": "<LOCAL_TRANSACTION_ID>",
    "originalCategoryId": "11010000",
    "effectiveCategory": {"id": "08040000", "label": "Vestuário"},
    "rule": {"id": "<LOCAL_RULE_ID>", "scope": "DESCRIPTION_RAW_NORMALIZED", "origin": "SUGGESTION_ACCEPTED"},
    "metricsInvalidated": ["month-spend:2026-01"]
  }
}
```

Repetir o mesmo request é idempotente.

Erros desta rota: `404 RESOURCE_NOT_FOUND` para transação ou categoria inexistente; `409 STALE_OVERRIDE_TARGET` se o `If-Match` não corresponder à versão atual; `422 OVERRIDE_NOT_ELIGIBLE` se o matcher escolhido não existir na transação; `428 PRECONDITION_REQUIRED` se `If-Match` faltar. Texto arbitrário e criação de categoria são rejeitados com `400 VALIDATION_ERROR`.

### `PUT /api/v1/transactions/:id/internal-transfer-override`

Parâmetros: path `id` obrigatório, `transactions.public_id` local opaco de transação existente; header `If-Match: "<TRANSACTION_ETAG>"` obrigatório, com o `version` recebido em `GET /api/v1/transactions`; body conforme abaixo. Não há query string.

Identidade: identidade humana da opção de borda aprovada. É a segunda e última escrita financeira.

Request (exemplo fictício):

```json
{"value": true}
```

`true` força transferência interna, `false` força operação externa e `null` volta à detecção automática. O backend invalida as métricas afetadas na mesma transação.

Resposta `200` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "data": {
    "transactionId": "<LOCAL_TRANSACTION_ID>",
    "derivedValue": false,
    "overrideValue": true,
    "effectiveValue": true,
    "metricsInvalidated": ["month-spend:2026-01"]
  }
}
```

Erros desta rota: `400 VALIDATION_ERROR` se `value` não for boolean ou `null`; `404 RESOURCE_NOT_FOUND` para transação inexistente; `409 STALE_OVERRIDE_TARGET` se o `If-Match` não corresponder à versão atual; `428 PRECONDITION_REQUIRED` se `If-Match` faltar.

### `POST /api/v1/ai/actions`

Parâmetros: nenhum na query; body fechado. `period` é obrigatório para `MONTHLY_NARRATIVE` e `COMMENT_FORECAST`; `targetRef` é obrigatório para as demais ações e sempre é ID local já fornecido pela UI.

Identidade: identidade humana da opção de borda aprovada; rate limit por identidade de borda.

Request (exemplo fictício, disparado por controle de um clique):

```json
{
  "action": "MONTHLY_NARRATIVE",
  "period": "2026-01",
  "targetRef": null
}
```

Ações allowlisted: `MONTHLY_NARRATIVE`, `EXPLAIN_ANOMALY`, `NAME_RECURRENCE`, `SUGGEST_CATEGORY`, `COMMENT_FORECAST`. Não há campo de lançamento nem input financeiro.

Resposta (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"metricRefs": 2},
  "metricVersion": "monthly-narrative.v1",
  "quality": "complete",
  "data": {
    "action": "MONTHLY_NARRATIVE",
    "result": {"title": "Resumo fictício do mês", "body": "O gasto confirmado ficou acima da referência fictícia."},
    "metricRefs": ["month-spend:2026-01", "month-forecast:2026-01"],
    "freshnessStatus": "FRESH"
  }
}
```

Consulta livre fica para o chat do Hermes na fase própria.

Erros desta rota: `400 VALIDATION_ERROR` para ação ou combinação de contexto inválida; `404 RESOURCE_NOT_FOUND` para `targetRef` local inexistente; `422 METRIC_NOT_AVAILABLE` para contexto insuficiente; `503 AI_UNAVAILABLE` quando modelo primário e fallback falham.

### `GET /api/v1/system/health`

Parâmetros: nenhum.

Identidade: identidade humana da opção de borda aprovada, conforme o contrato comum acima.

Resposta (exemplo fictício; nenhum ID externo é devolvido):

```json
{
  "schemaVersion": "1.0",
  "data": {
    "status": "HEALTHY",
    "item": {"status": "UPDATED", "nextAutoSyncAt": "2026-01-16T09:00:00Z", "consent": "NOT_EXPIRING"},
    "freshness": {"lastSuccessfulSyncAt": "2026-01-15T11:58:00Z", "dataAgeSeconds": 120, "status": "FRESH"},
    "lastRun": {"status": "SUCCEEDED", "inserted": 2, "updated": 5, "tombstoned": 0},
    "pendingTransactions": 1,
    "webhookInbox": {"received": 0, "failed": 0, "dead": 0}
  }
}
```

Erros desta rota: `503 DATA_STALE` somente quando não existe último estado operacional confiável; degradações conhecidas retornam `200` com `status: "DEGRADED"` e razões fechadas, mantendo o último dado válido.

## API para agentes

Todos os contratos usam `Content-Type: application/json`, `schemaVersion` e payload compacto.

### Escopos

| Escopo | Permite |
|---|---|
| `metrics:read` | resumos, projeções, categorias e saúde |
| `events:read` | ler snapshot não terminal da outbox, sem adquirir lease |
| `events:claim` | adquirir lease atômico para eventos selecionados |
| `events:ack` | confirmar entrega operacional; não altera finanças |
| `clarifications:read_private` | fase posterior: obter o mínimo exato necessário para uma pergunta em canal financeiro privado |
| `clarifications:write` | fase posterior: resolver uma clarificação já aberta, sem criar lançamento |
| `ai:query` | submeter consulta textual ao context builder sanitizado |

O token inicial recebe `metrics:read events:read events:claim events:ack`. Claim e ack só movem a outbox; a primeira integração permanece somente leitura financeira. `clarifications:read_private`, `clarifications:write` e `ai:query` ficam fora dela e exigem fase, token e gate próprios. Não existe `transactions:write`.

### `GET /api/agent/v1/summary?period=YYYY-MM`

Parâmetros: query `period` obrigatório no formato `YYYY-MM`.

Identidade: token de serviço com escopo `metrics:read`; loopback não substitui o token.

Resposta (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"metrics": 2},
  "metricVersion": "agent-summary.v1",
  "quality": "complete",
  "metrics": [
    {"metricId": "month-spend:2026-01", "name": "monthSpend", "value": 1320.40, "currencyCode": "BRL"},
    {"metricId": "month-forecast:2026-01", "name": "forecast", "value": 2410.00, "currencyCode": "BRL"}
  ],
  "freshnessStatus": "FRESH"
}
```

Erros desta rota: `400 VALIDATION_ERROR` para período inválido; `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `422 METRIC_NOT_AVAILABLE` se o mês não tiver cobertura mínima.

### `GET /api/agent/v1/projection?month=YYYY-MM`

Parâmetros: query `month` obrigatório no formato `YYYY-MM`.

Identidade: token de serviço com escopo `metrics:read`.

Resposta (exemplo fictício; não contém transações cruas):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"components": 4},
  "metricVersion": "month-forecast.v1",
  "quality": "complete",
  "projection": {"amount": 2410.00, "rangeLow": 2230.00, "rangeHigh": 2620.00, "currencyCode": "BRL", "metricIds": {"amount": "month-forecast:2026-01", "rangeLow": "month-forecast-low:2026-01", "rangeHigh": "month-forecast-high:2026-01"}},
  "components": [
    {"kind": "CONFIRMED", "amount": 1320.40, "metricId": "month-forecast-confirmed:2026-01"},
    {"kind": "PENDING", "amount": 86.30, "metricId": "month-forecast-pending:2026-01"},
    {"kind": "NON_RECURRING_PACE_FUTURE", "amount": 943.40, "metricId": "month-forecast-pace-future:2026-01"},
    {"kind": "EXPECTED_RECURRENCES", "amount": 59.90, "metricId": "month-forecast-recurrences:2026-01"}
  ],
  "metricRefs": ["month-forecast:2026-01", "month-forecast-confirmed:2026-01", "month-forecast-pending:2026-01", "month-forecast-pace-future:2026-01", "month-forecast-recurrences:2026-01"],
  "freshnessStatus": "FRESH"
}
```

Erros desta rota: `400 VALIDATION_ERROR` para mês inválido; `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `422 METRIC_NOT_AVAILABLE` para projeção sem amostra mínima.

### `GET /api/agent/v1/anomalies?since=<INSTANT>&limit=20`

Parâmetros: `since` opcional em ISO 8601 UTC, padrão nas últimas 24 horas; `limit` opcional de 1 a 100, padrão 20.

Identidade: token de serviço com escopo `metrics:read`.

Resposta em `occurredAt DESC, id DESC` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-14T12:00:00Z", "to": "2026-01-15T12:00:00Z", "timezone": "UTC"},
  "currencyCode": "BRL",
  "counts": {"anomalies": 1},
  "metricVersion": "agent-anomalies.v1",
  "quality": "complete",
  "anomalies": [{"id": "<LOCAL_ANOMALY_ID>", "kind": "DUPLICATE", "severity": "HIGH", "summary": "Possível cobrança fictícia repetida.", "occurredAt": "2026-01-15T10:00:00Z", "metricRefs": ["anomaly:<LOCAL_ANOMALY_ID>"]}],
  "freshnessStatus": "FRESH"
}
```

Erros desta rota: `400 VALIDATION_ERROR` para instante ou limite inválido; `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `503 DATA_STALE` quando o consumidor exige janela mais recente que a cobertura disponível.

### `GET /api/agent/v1/events?cursor=<CURSOR>&limit=20`

Parâmetros: `cursor` local opaco e opcional; `limit` opcional de 1 a 100, padrão 20.

Identidade: token de serviço com escopo `events:read`.

Resposta em `occurredAt ASC, id ASC`; a leitura é estritamente read-only e inclui eventos não terminais `PENDING` e `LEASED`, sem revelar `leaseToken` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "events": [{"id": "<LOCAL_EVENT_ID>", "eventType": "BILL_DUE_SOON", "severity": "HIGH", "occurredAt": "2026-01-15T10:00:00Z", "deliveryState": "PENDING", "payload": {"accountId": "<LOCAL_ACCOUNT_ID>", "daysUntilDue": 3, "metricRefs": ["bill-due:<LOCAL_ACCOUNT_ID>:2026-02-10"]}}],
  "nextCursor": "<LOCAL_CURSOR>"
}
```

O cursor serve apenas para paginar um snapshot com fronteira fixa. Evento `LEASED` não é filtrado do snapshot, portanto não fica para trás se o lease expirar. Cada novo ciclo de polling começa sem cursor; o cursor final nunca é salvo como checkpoint de consumo.

Erros desta rota: `400 VALIDATION_ERROR` para cursor ou limite inválido; `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `503 DEPENDENCY_NOT_READY` se a outbox não puder ser lida consistentemente.

### `POST /api/agent/v1/events/claim`

Parâmetros: nenhum na query; body com `eventIds` de 1 a 20 IDs locais opacos e distintos e `leaseSeconds` opcional de 30 a 300, padrão 120. A identidade do consumidor vem do token, não do body.

Identidade: token de serviço com escopo `events:claim`.

Request (exemplo fictício):

```json
{
  "eventIds": ["<LOCAL_EVENT_ID>"],
  "leaseSeconds": 120
}
```

Resposta `200` (exemplo fictício; `leaseToken` é opaco e de uso único por lease):

```json
{
  "schemaVersion": "1.0",
  "claims": [
    {
      "eventId": "<LOCAL_EVENT_ID>",
      "leaseToken": "<OPAQUE_LEASE_TOKEN>",
      "leaseUntil": "2026-01-15T10:02:00Z",
      "event": {"eventType": "BILL_DUE_SOON", "severity": "HIGH", "occurredAt": "2026-01-15T10:00:00Z", "payload": {"accountId": "<LOCAL_ACCOUNT_ID>", "daysUntilDue": 3, "metricRefs": ["bill-due:<LOCAL_ACCOUNT_ID>:2026-02-10"]}}
    }
  ]
}
```

O claim é all-or-none numa única transação SQLite: todos os eventos precisam estar `PENDING` ou com lease expirado. Qualquer indisponibilidade retorna conflito e nenhum lease do request é concedido.

Erros desta rota: `400 VALIDATION_ERROR` para lista, duplicata ou duração inválida; `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `404 RESOURCE_NOT_FOUND` para ID inexistente/terminal; `409 EVENT_LEASE_CONFLICT` se algum evento tiver lease válido; `503 DEPENDENCY_NOT_READY` se o claim não puder ser confirmado atomicamente.

### `POST /api/agent/v1/events/:id/ack`

Parâmetros: path `id` obrigatório, ID local opaco do evento; body conforme abaixo.

Identidade: token de serviço com escopo `events:ack`.

Request (exemplo fictício):

```json
{
  "leaseToken": "<OPAQUE_LEASE_TOKEN>",
  "deliveryId": "<DELIVERY_ID>",
  "outcome": "DELIVERED",
  "reasonCode": null
}
```

Resposta `200` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "data": {"eventId": "<LOCAL_EVENT_ID>", "status": "DELIVERED", "duplicateAck": false}
}
```

`outcome` aceita `DELIVERED` ou `DISMISSED`. Para `DISMISSED`, `reasonCode` é obrigatório e limitado a `POLICY_SUPPRESSED`, `NO_AUTHORIZED_CHANNEL` ou `SUPERSEDED_BY_NEWER_EVENT`; para `DELIVERED`, deve ser `null`. Dismiss é decisão terminal operacional explícita, não falha/retry e não alteração financeira.

Na primeira transição terminal, o `leaseToken` precisa pertencer ao evento, ao principal chamador e a um lease ainda válido. Depois que o ack foi commitado, replay do mesmo evento + principal + `deliveryId` + body normalizado retorna `200` com `duplicateAck: true` mesmo após expirar o lease; essa checagem terminal precede a validação do lease. Reuso do `deliveryId` por outro evento/principal ou com body diferente retorna `409 EVENT_LEASE_CONFLICT`/`IDEMPOTENCY_KEY_REUSED`, sem alterar o terminal.

Erros desta rota: `400 VALIDATION_ERROR` para `leaseToken`, `deliveryId` ou `outcome` inválido; `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `404 RESOURCE_NOT_FOUND` para evento inexistente; `409 EVENT_LEASE_CONFLICT` para lease expirado/de outro consumidor ou `deliveryId` ligado a outro evento.

### Clarificação privada — H5/F8

Fase futura e explicitamente fora da primeira integração Hermes. O backend abre a clarificação e emite `UNKNOWN_TRANSACTION_NEEDS_CONTEXT`; o Hermes decide a interface privada — Discord ou outra —, os botões e o eventual campo opcional. O backend não recebe nem persiste canal.

O evento entregue por `GET /events` e `POST /events/claim` usa payload compacto como este (exemplo fictício; IDs são locais):

```json
{
  "eventType": "UNKNOWN_TRANSACTION_NEEDS_CONTEXT",
  "severity": "INFO",
  "payload": {
    "clarificationId": "<LOCAL_CLARIFICATION_ID>",
    "version": "<CLARIFICATION_ETAG>",
    "transactionId": "<LOCAL_TRANSACTION_ID>",
    "context": {"direction": "DEBIT", "occurredDate": "2026-01-14", "amountBand": "BRL_10_TO_99"},
    "categorySuggestions": [{"suggestionRef": "<LOCAL_SUGGESTION_REF>", "categoryId": "08000000", "label": "Compras"}]
  }
}
```

Não há descrição crua, merchant, documento, valor exato, ID Pluggy ou identificador de conta/cartão. Se nenhum sinal seguro existir, `context` e `categorySuggestions` podem ser vazios.

#### `GET /api/agent/v1/clarifications/:id`

Somente depois de o perfil `financas` selecionar seu canal Discord privado allowlisted, ele pode buscar o mínimo necessário para o usuário reconhecer o pagamento. O evento genérico continua sem valor exato; esta rota separada reduz o blast radius de `events:read`.

Identidade: principal futuro exclusivo do perfil financeiro com `clarifications:read_private`; `events:read`, `events:claim`, loopback ou outro perfil não bastam. Resposta usa `Cache-Control: private, no-store`, não entra em log/cache/telemetria e é apagada da memória do bridge após a mensagem.

Resposta (exemplo fictício; `id` e `transactionId` são locais):

```json
{
  "schemaVersion": "1.0",
  "data": {
    "id": "<LOCAL_CLARIFICATION_ID>",
    "version": "<CLARIFICATION_ETAG>",
    "transactionId": "<LOCAL_TRANSACTION_ID>",
    "context": {"direction": "DEBIT", "occurredDate": "2026-01-14", "amount": 73.45, "currencyCode": "BRL"},
    "categorySuggestions": [{"suggestionRef": "<LOCAL_SUGGESTION_REF>", "categoryId": "08000000", "label": "Compras"}],
    "applyToSimilar": {"available": true, "matcherKind": "SOURCE_FINGERPRINT_V1", "confidence": "HIGH"}
  }
}
```

`amount` é a única informação financeira exata adicional e existe porque data + faixa não identificam de forma confiável um pagamento sem descrição. A rota nunca devolve saldo, conta, cartão, CPF/CNPJ, merchant, descrição, texto de operação, IDs Pluggy ou fingerprint; não existe campo livre de “pista” nesta versão. Se a transação mudou desde a abertura, retorna `409 STALE_CLARIFICATION_TARGET` e fecha/substitui o episódio antes de qualquer pergunta.

Erros da API: `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `404 RESOURCE_NOT_FOUND`; `409 STALE_CLARIFICATION_TARGET`. Antes da chamada, o bridge Hermes precisa validar sua configuração local; sem destino privado allowlisted, ele aborta localmente com `PRIVATE_CHANNEL_NOT_CONFIGURED` e **não chama** a API. O backend não recebe nem tenta inferir ID de canal.

#### `POST /api/agent/v1/clarifications/:id/resolve`

Parâmetros:

| Local | Nome | Obrigatório | Regra |
|---|---|---:|---|
| path | `id` | sim | ID local opaco da clarificação |
| header | `If-Match` | sim | `version` recebido no evento |
| header | `Idempotency-Key` | sim | valor opaco único por decisão; o backend persiste somente o hash |
| body | `resolutionType` | sim | `ACCEPT_CATEGORY_SUGGESTION` ou `SET_NORMALIZED_ALIAS` |
| body | `suggestionRef` | condicional | obrigatório apenas ao aceitar sugestão |
| body | `normalizedAlias` | condicional | obrigatório apenas ao definir alias |
| body | `applyToSimilar` | sim | boolean; `true` só é aceito se o backend já ofereceu matcher seguro/versionado |

Identidade: token de serviço futuro com escopo exclusivo `clarifications:write`; `events:ack`, loopback ou escopo de leitura não autorizam esta rota.

Request ao aceitar botão de categoria (exemplo fictício):

```json
{
  "resolutionType": "ACCEPT_CATEGORY_SUGGESTION",
  "suggestionRef": "<LOCAL_SUGGESTION_REF>",
  "normalizedAlias": null,
  "applyToSimilar": true
}
```

Para resposta opcional, o body usa `resolutionType: "SET_NORMALIZED_ALIAS"`, `normalizedAlias` entre 1 e 60 caracteres após NFKC, trim e redução de espaços, e pode trazer uma `suggestionRef` já emitida para salvar alias + categoria na mesma decisão. A denylist rejeita documento, e-mail, telefone e sequências longas de dígitos; não existe campo livre adicional.

Resposta `200` (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "data": {
    "clarificationId": "<LOCAL_CLARIFICATION_ID>",
    "transactionId": "<LOCAL_TRANSACTION_ID>",
    "status": "RESOLVED",
    "resolutionType": "ACCEPT_CATEGORY_SUGGESTION",
    "category": {"id": "08000000", "label": "Compras"},
    "normalizedAlias": null,
    "rule": {"id": "<LOCAL_RULE_ID>", "kind": "SOURCE_FINGERPRINT_V1", "status": "CREATED", "applyToSimilar": true},
    "version": "<NEW_CLARIFICATION_ETAG>"
  }
}
```

A mesma chave com o mesmo body devolve a resposta anterior. A sugestão nunca autoriza criar categoria; alias/regra só usa o matcher seguro derivado e oferecido pelo backend. `applyToSimilar: true` cria `category_overrides`/`transaction_alias_rules` se `matcherKind` for CNPJ/descrição ou `transaction_context_rules` se for `SOURCE_FINGERPRINT_V1/HIGH`; baixa confiança retorna `422 SIMILAR_RULE_NOT_SAFE` e o usuário pode repetir com `false`. Sem matcher reutilizável, a clarificação fica resolvida apenas para a transação e `rule.status` é `NOT_CREATED`, sem regra ampla por heurística.

Quando `reasonCodes` contém `CONTEXT_RULE_REVIEW`, a clarificação foi aberta na primeira reaplicação de uma regra e traz internamente `source_context_rule_id`. Se a decisão normalizada divergir da aplicação, o mesmo commit marca `transaction_context_rule_applications.status = CORRECTED`, incrementa `correction_count`, desativa a regra de origem e aplica a correção; uma substituta só é criada se o request trouxer `applyToSimilar: true` e um matcher seguro vigente. Se a revisão expirar, a aplicação permanece e nenhuma nova pergunta em loop é gerada.

Erros desta rota: `400 VALIDATION_ERROR` para união, alias ou `Idempotency-Key` inválidos; `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `404 RESOURCE_NOT_FOUND` para clarificação/sugestão inexistente; `409 STALE_CLARIFICATION_TARGET` para versão divergente; `409 IDEMPOTENCY_KEY_REUSED` para a mesma chave com outro body; `422 CLARIFICATION_NOT_ELIGIBLE` para transação já resolvida ou tombstonada; `422 SIMILAR_RULE_NOT_SAFE` para reaplicação sem matcher de alta confiança; `428 PRECONDITION_REQUIRED` se `If-Match` faltar.

### `POST /api/agent/v1/query`

Parâmetros: nenhum na query; body com `question` obrigatório de 1 a 500 caracteres e `period` opcional em `YYYY-MM`. O texto nasce no chat Hermes, não em formulário financeiro.

Identidade: fase futura; token de serviço com escopo `ai:query` e rate limit por token.

Request (exemplo fictício):

```json
{
  "question": "Como ficou o gasto fictício deste mês?",
  "period": "2026-01"
}
```

Resposta (exemplo fictício):

```json
{
  "schemaVersion": "1.0",
  "computedAt": "2026-01-15T12:00:00Z",
  "dataThrough": "2026-01-15T11:58:00Z",
  "period": {"from": "2026-01-01", "to": "2026-02-01", "timezone": "America/Sao_Paulo"},
  "currencyCode": "BRL",
  "counts": {"metricRefs": 1},
  "metricVersion": "agent-query.v1",
  "quality": "complete",
  "data": {
    "intent": "MONTHLY_SPEND_SUMMARY",
    "answer": "O gasto confirmado fictício está acima da referência fictícia.",
    "metricRefs": ["month-spend:2026-01"],
    "freshnessStatus": "FRESH"
  }
}
```

O backend transforma a intenção em consulta allowlisted, calcula e monta contexto sanitizado. SQL, raw JSON e transações em massa nunca entram no modelo.

Erros desta rota: `400 VALIDATION_ERROR` para texto/período inválido; `401 SERVICE_TOKEN_INVALID`; `403 SCOPE_DENIED`; `422 METRIC_NOT_AVAILABLE` quando a intenção não mapear uma métrica autorizada; `503 AI_UNAVAILABLE` quando primário e fallback falharem.

## Códigos de erro

| HTTP | Código | Uso |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | formato, enum, período ou limite inválido |
| 401 | `EDGE_IDENTITY_REQUIRED` | identidade humana Access ou do proxy autenticador Tailscale não comprovada no origin |
| 401 | `SERVICE_TOKEN_INVALID` | token agente ausente, inválido ou revogado |
| 401 | `WEBHOOK_TOKEN_INVALID` | Bearer do webhook ausente ou inválido |
| 403 | `SCOPE_DENIED` | token válido sem escopo |
| 404 | `RESOURCE_NOT_FOUND` | ID local inexistente ou tombstone não exibível |
| 409 | `CURSOR_SNAPSHOT_EXPIRED` | cursor local não pertence mais a uma visão válida |
| 409 | `EVENT_LEASE_CONFLICT` | claim/ack não corresponde a lease disponível e válido |
| 409 | `IDEMPOTENCY_KEY_REUSED` | mesma chave de idempotência foi usada com outro body |
| 409 | `STALE_CLARIFICATION_TARGET` | clarificação mudou antes da resolução |
| 409 | `SYNC_IN_PROGRESS` | operação conflitante com lock de sync |
| 409 | `STALE_OVERRIDE_TARGET` | transação mudou antes da correção |
| 413 | `WEBHOOK_BODY_TOO_LARGE` | body excedeu o limite antes do parse |
| 422 | `CLARIFICATION_NOT_ELIGIBLE` | alvo não aceita mais a resolução proposta |
| 422 | `METRIC_NOT_AVAILABLE` | amostra insuficiente ou dado ausente |
| 422 | `OVERRIDE_NOT_ELIGIBLE` | matcher escolhido não existe na transação |
| 422 | `WEBHOOK_EVENT_UNSUPPORTED` | tipo do evento não pertence à allowlist |
| 428 | `PRECONDITION_REQUIRED` | mutação exige `If-Match` |
| 429 | `RATE_LIMITED` | limite de rota/token |
| 503 | `DATA_STALE` | contrato exige frescor maior que o disponível |
| 503 | `AI_UNAVAILABLE` | apenas ação de IA falhou; painel continua útil |
| 503 | `DEPENDENCY_NOT_READY` | dependência local necessária não está pronta |
| 503 | `PROCESS_DEGRADED` | processo iniciou encerramento fatal |
| 503 | `WEBHOOK_INBOX_UNAVAILABLE` | inbox não confirmou persistência durável |

## Cache e ETag

- Agregados GET recebem `ETag` derivado de `metricVersion`, filtros normalizados e `system_state.data_revision`, incrementado no mesmo commit que altera dado capaz de afetar métricas.
- Cada transação recebe `version = base64url(SHA-256(public_id + NUL + version_revision))`; `version_revision` incrementa uma vez no commit quando muda campo fonte servido, categoria/regra efetiva, transferência derivada/override, match de pagamento, classificação de crédito ou tombstone. Mudança em outra transação não invalida esse `If-Match`.
- O frontend usa `If-None-Match`.
- Respostas financeiras privadas usam `Cache-Control: private, no-store` na borda; o cache é somente em memória do cliente autenticado.
- Mutações invalidam ETags afetados.

## Observabilidade

Cada request recebe `requestId`, duração, rota parametrizada e status. Não logar query textual do Hermes, valores monetários, descriptions, headers, bodies ou IDs externos. Métricas operacionais usam contagens e códigos.

## Pendências / a confirmar

- Na rodada de deploy, configurar `Protect with Access` **e** revalidar no origin assinatura, `kid`, `iss`, `aud`, `exp`, `nbf` e e-mail; falta de autorização operacional bloqueia a publicação.
- Aprovar os escopos iniciais e o acknowledgement operacional do Hermes.
- Definir limites de taxa após medição local de uso; os contratos já exigem limites, mas os números não devem ser inventados antes do benchmark.
