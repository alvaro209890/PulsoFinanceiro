# 17 — Implementação da F2 (núcleo financeiro determinístico)

Registro do que foi construído na fase F2 do roadmap (`12-roadmap.md` §6), das
decisões tomadas onde o plano deixava espaço e do estado de cada item do gate.
Os documentos 01–16 continuam sendo o plano; este documento é o diário da
execução.

Data da entrega: 2026-08-24. Estado: **implementado e testado localmente**;
“validado” (artefato real controlado) e “publicado” continuam pendentes,
conforme a regra 2 do roadmap.

## 1. O que a fase entrega

O usuário abre a Visão geral e vê patrimônio observável, ritmo do mês,
projeção de fechamento, dia mais caro, mapa de calor, médias por dia da semana
e gasto por categoria com comparação — todos calculados no backend, com
composição auditável em um clique.

### Superfície nova

| Rota | Métrica | Arquivo |
|---|---|---|
| `GET /api/v1/dashboard/overview` | `dashboard-overview.v1` | `src/finance/overview.ts` |
| `GET /api/v1/analytics/monthly-pace` | `monthly-pace.v1` | `src/finance/pace.ts` |
| `GET /api/v1/analytics/categories` | `categories-rollup.v1` | `src/finance/categories.ts` |
| `GET /api/v1/transactions` | evidências (sem métrica agregada) | `src/finance/transactions.ts` |

Todas as respostas agregadas trazem `schemaVersion`, `computedAt`,
`dataThrough`, `period`, `currencyCode`, `counts`, `metricVersion` e `quality`,
com `metricId`/`metricIds` nos valores citáveis (`src/finance/envelope.ts`).
Agregados respondem `ETag` derivado de `metricVersion` + filtros normalizados +
`system_state.data_revision`, e `Cache-Control: private, no-store`.

### Persistência (migração 0003)

`balance_snapshots`, `credit_card_bills`, `bill_payments`,
`transaction_bill_payment_matches`, `categories.level1_prefix`, campos de
crédito em `accounts` e `system_state`.

### Fonte única de classificação

`src/finance/ledger.ts` é o único lugar que decide o que é gasto. Overview,
ritmo, categorias e evidências consomem esse razão — por isso os três contratos
não podem divergir em um centavo, e o teste
`os três contratos devolvem o mesmo gasto confirmado` prova isso.

Regra consolidada de gasto confirmado:

- saída (`DEBIT`) com status `POSTED`;
- fora de transferência interna efetiva (raiz `04`, flag derivada ou override);
- ausente de `transaction_bill_payment_matches` em **qualquer** role — os dois
  lados do pagamento de fatura saem do gasto;
- moeda comparável; mais de uma moeda no período devolve `not_comparable`.

Crédito em conta de cartão sem pareamento não reduz gasto: fica como
`cardCreditUnclassified`, rebaixa a qualidade para `partial` e aparece no DTO
como `cardCreditClassification: "UNCLASSIFIED"`. `PENDING` nunca entra em
realizado.

### Frontend (2D funcional, dark exclusivo)

`src/web/index.html` consome os três contratos e formata apenas data, moeda e
cor. **Sentinela de Camadas** aparece como anéis de saldo/obrigação, e
**Condutor do Pulso** como uma descarga única quando a razão do termômetro
muda — nunca em loop. `prefers-reduced-motion` desliga animação e transição
sem perder leitura. 3D/WebGL continua fora: o roadmap só o admite depois que o
fallback 2D cumpre o contrato, o que agora é o caso.

## 2. Decisões desta fase

Onde o plano não fixava um número, a implementação fixou — e declarou.

1. **Unidade mínima inteira.** O schema F0/F1 guarda `transactions.amount` como
   `REAL`; as tabelas novas guardam `*_minor` inteiro. As métricas convertem
   para centavos (`toMinor`) antes de somar e só voltam a decimal na borda.
   Nenhuma soma monetária acontece em ponto flutuante.
2. **Recorrências ausentes.** Elas pertencem à F3. A parcela
   `expectedRecurrencesNotYetCharged` é `0` e a projeção declara
   `RECURRENCES_NOT_AVAILABLE` em `reasonCodes`, em vez de embutir o valor no
   ritmo e fingir precisão.
3. **Faixa da projeção.** Com amostra utilizável, `rangeLow`/`rangeHigh` usam a
   dispersão observada (`min/média` e `max/média`) aplicada só à parcela
   futura. Sem amostra, usa ±15% e declara `NO_HISTORICAL_DISPERSION`.
4. **Confiança da projeção.** `HIGH` com ≥14 dias decorridos e ≥3 meses de
   amostra; `LOW` com amostra insuficiente ou menos de 7 dias; `MEDIUM` no
   resto.
5. **Cobertura do dia.** `complete` quando existe harvest bem-sucedido depois
   do fim do dia; `partial` no dia em andamento; `gap` quando nada garante que
   o dia foi lido. Lacuna nunca é pintada como zero e não entra nas médias por
   dia da semana.
6. **Janela comparável anterior.** Período que começa no dia 1 compara o mesmo
   recorte de dias do mês anterior; período arbitrário compara a janela
   imediatamente anterior de mesmo tamanho.
7. **`eligibility=SPEND` em `/api/v1/transactions`.** Parâmetro novo, ausente
   de `07-api-interna.md`: sem ele o drawer de composição listava a
   transferência interna e a soma não fechava com o card. A decisão continua no
   backend; o navegador não filtra dinheiro. **Pendente:** incorporar o
   parâmetro ao contrato em `07-api-interna.md`.
8. **`version` da transação.** O contrato prevê hash de
   `public_id + version_revision`; `version_revision` só existe no schema
   canônico da F5+. Aqui o hash usa `public_id + updated_at`, mantendo o
   formato e a semântica de `If-Match`. **Pendente:** migrar quando a coluna
   existir.
9. **Evento de ritmo (`PACE_POLICY_V1`).** `MONTH_PACE_HIGH` abre em ritmo
   ≥ 1,25 (WARNING), ≥ 1,5 (HIGH), ≥ 2,0 (CRITICAL) e só fecha abaixo de 1,15
   — histerese para não piscar na fronteira. Amostra insuficiente não gera
   alerta: ausência não é excesso. Limite de cartão (F3) e anomalia
   `LOG_ZSCORE` (F4) continuam sem emissão, como manda o gate.
10. **Identidade humana.** Continua na borda (ADR-016/017) e não foi criada
    aqui: o serviço só faz bind em `127.0.0.1` e a publicação não ocorreu.
    Nenhum cookie, sessão ou tabela de usuário foi introduzido.

## 3. Estado do gate de saída (roadmap §6)

| Item do gate | Estado |
|---|---|
| soma de composições fecha com cada card (mês completo, parcial, crédito de cartão classificado/não classificado, `PENDING`) | **coberto** por `tests/f2-nucleo.test.ts` e por `eligibility=SPEND` |
| prefixo `04`, overrides e pagamento de fatura não inflam gasto | **coberto** |
| mês parcial compara os mesmos dias; base zero não gera infinito | **coberto** |
| patrimônio mostra lacuna antes do primeiro snapshot | **coberto** |
| moeda incompatível, histórico insuficiente, stale e erro parcial com teste de contrato | **coberto** no contrato (`tests/f2-api.test.ts`); teste visual automatizado ainda não existe |
| browser em 360, 768 e 1440 px exibe os mesmos números da API | **verificado** com o servidor real nas três larguras (mesmos valores, sem overflow horizontal); revisão visual pixel a pixel ainda é manual |
| desligar WebGL ou reduzir movimento mantém leitura e ações | **coberto por construção**: não há WebGL nesta fase e `prefers-reduced-motion` desliga o movimento |

Fora da fase, por decisão do roadmap: cartão e recorrências (F3), anomalias e
poupança (F4), IA (F5), publicação e borda (F6).

## 4. Como verificar

```bash
npm test                      # 66 testes (F0 + F1 + F2)
npm run typecheck
npx tsx tests/e2e-f2.ts       # sobe o servidor real e confere os 3 contratos
npx tsx tests/e2e-f2.ts --serve   # mantém no ar em 127.0.0.1:3041 para inspeção
```

O E2E cria um banco sintético em diretório temporário: nenhum dado real,
nenhum segredo e nenhuma chamada à API da Pluggy.

## Pendências / a confirmar

- Incorporar `eligibility` ao contrato em `07-api-interna.md`.
- Trocar a base do `version` quando `version_revision` existir no schema.
- Teste visual automatizado dos estados de qualidade (hoje é inspeção manual).
- Snapshot só é gravado no fim de um harvest bem-sucedido: dias sem harvest
  ficam sem ponto na série, por decisão (não se fabrica histórico).
- Continua valendo: rotacionar credenciais Pluggy antes de qualquer conexão
  real e decidir a proteção de borda antes de publicar.
