# 20 — Implementação da Fase F8: Clarificação Privada e Query de IA para o Hermes

*(autor: Hermes-acer/default | 2026-08-28)*

## 1. Visão Geral

A **Fase F8** implementa o fluxo de clarificação privada de transações ambíguas/não categorizadas e a consulta aberta em linguagem natural para o Hermes via API de Agentes, alimentada pelo modelo **Gemini 3.7 Flash via 9Router**.

---

## 2. Entregáveis da Fase F8

### 2.1 Modelo de Dados (Migração 0005)
- **Tabela `transaction_clarifications`:** Registra perguntas de contexto abertas pelo detector, sugestões de categoria, status (`OPEN`, `RESOLVED`, `EXPIRED`, `SUPERSEDED`), versionamento (`If-Match`) e hash de idempotência.
- **Tabela `transaction_context_rules`:** Armazena regras aprendidas a partir da decisão do usuário (`applyToSimilar: true`), vinculando o matcher versionado (`SOURCE_FINGERPRINT_V1` ou CNPJ/descrição) à categoria e alias normalizado.

### 2.2 Endpoints da API de Agentes (`/api/agent/v1/*`)
- **`GET /api/agent/v1/clarifications/:id`:**
  - Exige escopo `clarifications:read_private`.
  - Retorna o contexto mínimo essencial (data, valor exato, moeda, direção e sugestões) com cabeçalho `Cache-Control: private, no-store`.
- **`POST /api/agent/v1/clarifications/:id/resolve`:**
  - Exige escopo `clarifications:write`, header `If-Match` e `Idempotency-Key`.
  - Suporta `ACCEPT_CATEGORY_SUGGESTION` e `SET_NORMALIZED_ALIAS`.
  - Atualiza a transação com `category_override = 1` e cria regra em `transaction_context_rules` quando `applyToSimilar = true`.
- **`POST /api/agent/v1/query`:**
  - Exige escopo `ai:query`.
  - Permite perguntas textuais livres sobre as finanças do mês diretamente do chat do Discord.
  - Constrói contexto determinístico sanitizado e consulta o **Gemini 3.7 Flash via 9Router**.

---

## 3. Testes & Qualidade

- **128 testes automatizados verdes** (`vitest run`).
- Validação ponta a ponta em produção no `server-desktop`.
- Principal `hermes-server` atualizado com todos os escopos: `metrics:read`, `events:read`, `events:claim`, `events:ack`, `clarifications:read_private`, `clarifications:write`, `ai:query`.
