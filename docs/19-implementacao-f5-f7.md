# 19 — Implementação das Fases F5 e F7: IA Narrativa e Integração com Hermes

*(autor: Hermes-acer/default | 2026-08-28)*

## 1. Visão Geral

Nesta rodada foram entregues e integradas duas fases fundamentais do **PulsoFinanceiro**:
1. **F5 — Camada de IA Narrativa:** Integrada ao 9Router da frota (`http://100.65.138.58:20128/v1`) com o modelo `ag/gemini-3.7-flash-high`.
2. **F7 — API de Agentes & Autenticação Machine-to-Machine:** Infraestrutura completa para consumo determinístico pelo Hermes sem expor dados brutos.

A fase F6 de endurecimento de borda pública foi dispensada pelo proprietário, mantendo o acesso seguro via Tailscale e loopback local.

---

## 2. Fase F5 — Camada de IA

### Entregáveis
- **Cliente de IA (`src/ai/client.ts`):** Interface OpenAI-compatible consumindo o endpoint do 9Router no `server-desktop`.
- **Sanitização Fail-Closed (`src/ai/sanitize.ts`):** Redação rigorosa de CPFs, CNPJs, cartões, e-mails, telefones e credenciais antes da montagem de prompts.
- **Casos de Uso (`src/ai/actions.ts`):**
  - `MONTHLY_NARRATIVE`: Resumo, mudanças relevantes e pontos de atenção com citação estrita de `metricRefs`.
  - `COMMENT_FORECAST`: Comentário de projeção e incertezas.
  - `EXPLAIN_ANOMALY`: Explicação de anomalias/duplicidades sem presunção de fraude.
  - `NAME_RECURRENCE`: Nome amigável e descrição para séries recorrentes.
  - `SUGGEST_CATEGORY`: Sugestão de categoria a partir da taxonomia local existente.
- **Endpoint:** `POST /api/v1/ai/actions`.
- **Interface Web:** Aba "Assistente IA" em `src/web/index.html`.

---

## 3. Fase F7 — Integração Hermes & Discord

### Entregáveis
- **Autenticação Machine-to-Machine (`src/routes/agentAuth.ts`):**
  - Validação de tokens Bearer via hash SHA-256 em tempo constante (`timingSafeEqual`).
  - Tabela `service_principals` com escopos `metrics:read`, `events:read`, `events:claim`, `events:ack`.
- **API de Agentes (`src/routes/agent.ts`):**
  - `GET /api/agent/v1/summary`: Resumo compacto de gasto e projeção.
  - `GET /api/agent/v1/projection`: Projeção detalhada de componentes.
  - `GET /api/agent/v1/anomalies`: Anomalias e duplicidades recentes.
  - `GET /api/agent/v1/events`: Leitura read-only da outbox de eventos.
  - `POST /api/agent/v1/events/claim`: Claim atômico (all-or-none) com lease temporário.
  - `POST /api/agent/v1/events/:id/ack`: Confirmação idempotente de entrega operacional.
- **Canal Discord:** Criado canal dedicado `💰｜pulso-financeiro` (ID `1542862231065329674`) na categoria `🤖 AGENTES` do servidor *Hermes Hub*.
- **Script de Briefing:** `~/.hermes/scripts/pulso-briefing.py` no server pronto para envio de resumo diário.

---

## 4. Testes & Qualidade

- **125 testes unitários e de integração verdes** (`npm test` / `vitest run`).
- Validação ponta a ponta com banco de dados real em produção.
- Deploy ativo no `server-desktop` via `pulso-financeiro.service`.
