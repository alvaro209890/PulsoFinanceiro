# PulsoFinanceiro

Painel financeiro pessoal, automático e self-hosted para transformar os dados já sincronizados pela Pluggy em visão consolidada, alertas e explicações acionáveis. O produto tem um único usuário, não possui cadastro nem autenticação própria e não recebe lançamentos manuais.

> Estado: **F0 + F1 + F2 implementadas** — Fastify + SQLite + cliente Pluggy + webhook inbox + staleness + outbox + núcleo financeiro determinístico (`/api/v1`) e painel dark 2D, com 66 testes. Deploy em produção ainda não feito; credenciais aguardam rotação. Diário da F2 em [`docs/17-implementacao-f2.md`](docs/17-implementacao-f2.md).

## Nome

Foram considerados:

- **PulsoFinanceiro** — escolhido: comunica acompanhamento contínuo, saúde do sistema e alertas sem sugerir digitação manual.
- **NexoFinanceiro** — bom para integração, mas menos direto sobre monitoramento.
- **PrismaFinanceiro** — comunica análise por ângulos, mas é menos específico sobre atualização contínua.

## Resultado pretendido

- Consolidar conta corrente, poupança, cartão e faturas.
- Sincronizar automaticamente sem pedir atualização manual do item da Pluggy.
- Usar webhook como sinal primário e reconciliação agendada como rede de segurança.
- Calcular métricas no backend e servir exatamente os mesmos números ao painel e, futuramente, ao Hermes.
- Manter PII e segredos fora do frontend, dos prompts de IA, dos logs e do Git.
- Permitir somente duas correções de dados em um clique: categoria e transferência interna.
- Entregar um frontend dark-only, muito animado e com 3D progressivo, usando arquétipos originais de leitura/proteção, pulso elétrico e conquista determinística para tornar organização e economia mais claras.
- Planejar uma fase futura em que o Hermes pergunta em Discord privado sobre transação sem contexto e reaplica a resposta segura em repetições, sem acoplar canal ao backend.

## Rodando a base (F0 + F1 + F2)

```bash
npm install
cp .env.example .env   # preencha PLUGGY_CLIENT_ID/SECRET (+ PLUGGY_ITEM_ID para sync)
npm run dev             # tsx watch em 127.0.0.1:3040
```

Testes:

```bash
npm test        # vitest — 66 testes
npm run typecheck
npx tsx tests/e2e-manual.ts       # E2E real: sobe o servidor e bate nos endpoints
npx tsx tests/e2e-f1.ts           # E2E F1: webhook → inbox → worker + staleness
npx tsx tests/e2e-f2.ts           # E2E F2: os três contratos devolvem os mesmos números
npx tsx tests/e2e-f2.ts --serve   # painel com banco sintético em 127.0.0.1:3041
```

## API

| Rota | Descrição |
|---|---|
| `GET /api/health` | saúde + staleness do item (`STALE_POLICY_V1`) |
| `GET /api/summary?period=YYYY-MM` | fechamento mensal simples (base F0) |
| `POST /api/sync/run` | dispara harvest manual (operacional) |
| `POST /api/webhooks/pluggy` | entrada de webhook (Bearer); envelope válido → inbox, resposta rápida |
| `GET /api/v1/dashboard/overview` | patrimônio observável, gasto, projeção, dia mais caro, heatmap, alertas |
| `GET /api/v1/analytics/monthly-pace` | termômetro do mês, faixa histórica e composição da projeção |
| `GET /api/v1/analytics/categories` | rollup por raiz com drill-down e comparação com o período anterior |
| `GET /api/v1/transactions` | evidências para "Ver composição" (`eligibility=SPEND` fecha com o card) |

As rotas `/api/v1/*` devolvem o envelope comum (`computedAt`, `dataThrough`, `period`, `currencyCode`, `counts`, `metricVersion`, `quality`) com `metricId` em cada valor citável, `ETag` e `Cache-Control: private, no-store`.

## O que já funciona (F0 + F1 + F2)

- **Harvest agendado**: job diário às 04:30 (config `HARVEST_HOUR`/`HARVEST_MINUTE`), paginação por cursor até `next=null`, trava anti-loop.
- **Webhook-first**: recepção síncrona valida Bearer + envelope, persiste idempotente por `eventId` na `webhook_inbox` e responde rápido; worker processa depois. Reentrega da Pluggy (até 9x) é inofensiva.
- **Escopo de conta**: `transactions/*` com conta desconhecida dispara refresh de `/accounts`; persistindo a ausência → DEAD `ACCOUNT_SCOPE_INVALID`.
- **STALE_POLICY_V1**: sem harvest após `nextAutoSyncAt + 6h` com dado ≥24h vira evento `SYNC_STALE` (WARNING/HIGH/CRITICAL por faixa); recuperação fecha o episódio e emite `SYNC_RECOVERED`.
- **Outbox**: dedup por episódio ativo (`dedup_key` único enquanto condição aberta), `occurrence_count` acumula repetições.

### Núcleo financeiro (F2)

- **Razão elegível único** (`src/finance/ledger.ts`): gasto confirmado exclui transferência interna (raiz `04`, flag ou override) e os **dois lados** do pagamento de fatura pareado; crédito de cartão sem pareamento não reduz gasto e rebaixa a qualidade para `partial`; `PENDING` fica em camada separada.
- **Patrimônio observável**: soma dos saldos `BANK` menos a obrigação aberta **copiada** no `balance_snapshots` do dia. Fatura que muda depois não reescreve dia anterior; antes do primeiro snapshot há lacuna, não série reconstruída.
- **Termômetro e projeção**: mês parcial compara os mesmos dias do histórico; média ≤ 0 devolve `null` com qualidade declarada, nunca infinito ou 0% inventado; a projeção publica cada componente e o motivo do que foi omitido.
- **Categorias**: rollup por raiz com filhos, comparação com a janela anterior comparável, base zero vira "nova no período" e "Sem categoria" é grupo distinto de "Outros".
- **Evento de ritmo** (`PACE_POLICY_V1`): `MONTH_PACE_HIGH` abre em 1,25 (WARNING/HIGH/CRITICAL por faixa) e só fecha abaixo de 1,15; sem entrega por canal nesta fase.
- **Painel dark 2D**: Sentinela de Camadas (anéis) e Condutor do Pulso (descarga única), heatmap com lacuna visível, drawer de composição e respeito a `prefers-reduced-motion`.

## Stack

| Camada | Escolha |
|---|---|
| Runtime | Node.js 22 + TypeScript estrito |
| Backend | Fastify |
| Banco | SQLite (better-sqlite3) com WAL + foreign_keys |
| Testes | Vitest (66 testes, fetch mockado — nunca toca a API real) |
| Frontend | shell HTML único dark (F0–F2); React/Vite e 3D lazy entram depois |
| IA | fase futura (docs/10) |

## Segurança

- Segredos **somente via ambiente**; `.gitignore` bloqueia `.env*`, bancos, dumps e exports.
- Denylist canônica remove CPF/documento/número de conta antes de qualquer persistência (`src/pluggy/sanitize.ts`, testada).
- Endpoint legado `GET /transactions` proibido (HTTP 410 no tenant); só `/v2/transactions`.
- Nunca força update do Item — auto-sync da Pluggy + harvest local.

## Documentação completa

Os 16 documentos de planejamento estão em [`docs/`](docs/) — começar por `01-visao-e-escopo.md`. ADRs em `13-decisoes.md`. O diário de execução das fases entregues está em `17-implementacao-f2.md`.

## Pendências / a confirmar

- Rotacionar credenciais Pluggy antes de conectar produção (foram expostas em conversa).
- Provisionar webhook `https://pulso-hooks.cursar.space/api/webhooks/pluggy` (modalidade por aplicação).
- Gate de licença JJK vs mascotes originais (ADR-024) antes de assets públicos.
