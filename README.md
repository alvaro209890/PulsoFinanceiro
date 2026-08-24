# PulsoFinanceiro

Painel financeiro pessoal, automático e self-hosted para transformar os dados já sincronizados pela Pluggy em visão consolidada, alertas e explicações acionáveis. O produto tem um único usuário, não possui cadastro nem autenticação própria e não recebe lançamentos manuais.

> Estado: **F0 (base) implementada** — servidor Fastify + SQLite funcionando com testes. Sincronização Pluggy ainda não ligada em produção (F1).

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

## Rodando a base (F0)

```bash
npm install
cp .env.example .env   # preencha PLUGGY_CLIENT_ID/SECRET
npm run dev             # tsx watch em 127.0.0.1:3040
```

Testes:

```bash
npm test        # vitest — 19 testes
npm run typecheck
```

## API base

| Rota | Descrição |
|---|---|
| `GET /api/health` | saúde do processo + último sync |
| `GET /api/summary?period=YYYY-MM` | fechamento mensal determinístico |
| `POST /api/sync/run` | dispara harvest manual (operacional) |
| `POST /api/webhooks/pluggy` | entrada de webhook (Bearer) |

## Stack

| Camada | Escolha |
|---|---|
| Runtime | Node.js 22 + TypeScript estrito |
| Backend | Fastify |
| Banco | SQLite (better-sqlite3) com WAL + foreign_keys |
| Testes | Vitest (19 testes, fetch mockado — nunca toca a API real) |
| Frontend | shell HTML único dark na F0; React/Vite entram depois |
| IA | fase futura (docs/10) |

## Segurança

- Segredos **somente via ambiente**; `.gitignore` bloqueia `.env*`, bancos, dumps e exports.
- Denylist canônica remove CPF/documento/número de conta antes de qualquer persistência (`src/pluggy/sanitize.ts`, testada).
- Endpoint legado `GET /transactions` proibido (HTTP 410 no tenant); só `/v2/transactions`.
- Nunca força update do Item — auto-sync da Pluggy + harvest local.

## Documentação completa

Os 16 documentos de planejamento estão em [`docs/`](docs/) — começar por `01-visao-e-escopo.md`. ADRs em `13-decisoes.md`.

## Pendências / a confirmar

- Rotacionar credenciais Pluggy antes de conectar produção (foram expostas em conversa).
- Provisionar webhook `https://pulso-hooks.cursar.space/api/webhooks/pluggy` (modalidade por aplicação).
- Gate de licença JJK vs mascotes originais (ADR-024) antes de assets públicos.
