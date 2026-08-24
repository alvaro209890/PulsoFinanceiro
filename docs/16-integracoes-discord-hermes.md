# 16 — Integrações Discord/Hermes: auditoria viva e ideias aprováveis

*(autor: Hermes-server | rodada 24/08/2026, a pedido do Álvaro — "auditoria melhor dos meus servidores Discord e agentes Hermes e integrações bem legais")*

Complementa `14-integracao-hermes.md`. Nada aqui revoga escopos, outbox ou limites de responsabilidade já definidos.

## 1. Auditoria viva da frota (24/08/2026, read-only)

Fontes: Segundo Cérebro (`02-projetos/agentes-por-canal-discord.md`, `01-infra/*`), memória local do Hermes-server e estado reportado na auditoria anterior registrada em `14-integracao-hermes.md`.

### 1.1 Topologia atual

| Corpo | Servidor Discord | Perfis/canais | Papel para o Pulso |
|---|---|---|---|
| `hermes-server` | Hermes Hub (guild `1528221963229859961`) | `default`, `geoforest`, `acompanhamento`, `wms` | **host 24/7** do app + banco; candidato natural ao perfil `financas` |
| `hermes-acer` | Hermes Acer (guild `1528545203869450381`) | `default`, `trello`, `acompanhamento`, `geoforest`, `solicitacoes` | WhatsApp de saída; tarefas IMAP/SIMCAR |
| `hermes-windows` | (gateway no logon) | `default`, `cartografo`, `documentos`, `zelador` | nada financeiro; permanece fora do raio do Pulso |

13 perfis no total; handoff entre corpos exclusivamente por Kanban.

### 1.2 Riscos e melhorias observadas (sem mexer em produção nesta rodada)

| # | Achado | Impacto no Pulso | Ação recomendada | Quando |
|---|---|---|---|---|
| R1 | Heartbeat/status do acer em `active (elapsed)` sem execução desde 22/08; presença congelada | alerta de sync poderia ficar preso num corpo dormindo | reativar/timer de status; antes da F7 o `financas` deve checar presença do corpo alvo antes de claim | pré-F7 |
| R2 | Modelos/reasoning heterogêneos entre corpos vs. registro do vault | mensagens de alerta com qualidade irregular entre canais | padronizar modelo dos perfis que falam de dinheiro (`financas` server) no config, não no prompt | pré-F7 |
| R3 | Sem dashboard/listener `:9119` no Windows | impossibilita observação remota — irrelevante p/ Pulso, mas registra | documentado; nenhuma ação | — |
| R4 | Discord "fortemente indicado" mas entrega real nunca provada sem mensagem ativa | risco de outbox entregar e ninguém confirmar | F7 começa com **mensagem canário** num canal privado de teste + ack manual; só depois ligar eventos automáticos | F7 gate |
| R5 | `UNKNOWN_TRANSACTION_NEEDS_CONTEXT` depende de canal privado allowlisted que ainda não existe | clarificação H5/F8 bloqueada | criar canal `💰｜pulso-financeiro` privado (só Álvaro + bot do server) na hora da F7 | F7 |
| R6 | Credenciais Pluggy expostas em conversa (registrado em `04`) | nenhuma direta, mas reforça cultura | rotação antes da F1; segredos sempre em secret store, nunca em chat | pré-F1 |

### 1.3 O que a auditoria confirma como saudável

Gateways ativos nos três corpos, TLS persistente, `.env` Linux em 600, nenhum token de bot duplicado em perfil secundário, memórias abaixo do teto. A base é boa — os riscos acima são de rotina, não de arquitetura.

## 2. Integrações propostas ("bem legais" mas dentro das regras)

Todas respeitam: backend não conhece canal; Hermes lê métricas, não recalcula; handoff por Kanban; zero PII em canal coletivo.

### I1 — 💰 Canal `financas` no server com briefing diário

Perfil novo `financas` (server) consome `GET /summary` + `GET /events` uma vez pela manhã e posta no canal privado `💰｜pulso-financeiro`: fechamento de ontem, projeção do mês, anomalias abertas, saúde do sync. Silêncio = dia normal (nada crítico). Formato curto, tabela, `metricRefs`. É a integração âncora — as outras penduram nela.

### I2 — Comando `/pulso` no Discord

Slash command do bot do server que consulta a API do agente (`ai:query` na fase própria) para perguntas allowlisted: "quanto gastei em iFood esse mês?", "status da fatura", "tenho assinatura subindo de preço?". Resposta cita `metricId` + frescor. Em canal privado pode citar valores; em coletivo, só forma qualitativa.

### I3 — Alertas com ação de um clique (reactions como ACK)

Evento entregue no canal privado aceita reação ✅ do Álvaro como `outcome=DISMISSED/POLICY_SUPPRESSED` (via perfil `financas` chamando ack). Reação 🔁 reabre como episódio novo. O lease/ack já existe na API — isso é só UX do lado Hermes.

### I4 — "Pergunta do mistério" (H5/F8, já planejada — refinamento)

Transação sem contexto vira pergunta no canal privado com **botões** (componente Discord), não texto livre: sugestões de categoria existentes + alias curto validado + "abrir painel". Resposta via botão chama `clarifications/:id/resolve` com `If-Match` + `Idempotency-Key`. Reduz atrito vs. digitar resposta e mantém o contrato estreito da ADR-025.

### I5 — Fechamento mensal no Segundo Cérebro (já esboçado em `14` §Fechamento)

Refinamento: página única `02-projetos/pulsfinanceiro-fechamentos.md` com resumo **não sensível** (percentuais, variações, contagens — sem saldo absoluto nem descrição de merchant). Commit pelo protocolo do vault (lock + autor). O Álvaro aprova o formato antes do primeiro commit.

### I6 — Vigia financeiro (cron do próprio server)

Timer local (sem LLM) que roda `GET /health` a cada 15 min e, em CRITICAL, cria cartão Kanban para o `zelador`/`default` reiniciar serviço. Não passa pelo Discord; é infra falando com infra. Usa o mesmo principal machine-to-machine com escopo mínimo `metrics:read`.

### I7 — Digest semanal no WhatsApp (acer)

O único uso do WhatsApp, somente saída, já previsto: sexta à noite, resumo de 6 linhas (gasto da semana vs média, fatura a vencer, marcos novos). Handoff server→acer por Kanban conforme regra da casa. Opt-in do Álvaro; se ele silenciar, digest morre sem retry agressivo.

### I8 — Marcos no Discord (ponte com o front anime)

Quando `milestone_events` ganha marco novo (doc `15` §3), o evento sai pela outbox (`INFO`) e o `financas` celebra no canal privado com o mesmo microcopy do Catalisador ("Não foi sorte. Foi constância."). Integra front ↔ frota sem custo novo de backend.

### 2.1 Ordem de implantação

```
pré-F1: rotação de credenciais (R6)
F6 estável → I6 (vigia) → F7 gate: R4 canário + I1
I1 estável → I3 → I8 → I2
H5/F8 gate: R5 canal privado → I4
sempre depois, opt-in: I5 → I7
```

Cada letra vira fase verificável no roadmap da integração; nenhuma nasce automática sem passar pelo gate de mensagem canário.

## 3. Pendências / a confirmar

- Álvaro aprova lista I1–I8 e ordem; cortar o que não quiser.
- Definir dono do slash command (bot existente do server vs. bot dedicado) na F7.
- Confirmar política de retenção das mensagens do canal privado (o Discord retém; definir o que pode ser apagado por rotina).
- R1/R2 precisam de janela de manutenção acordada — este doc não altera config de produção.
