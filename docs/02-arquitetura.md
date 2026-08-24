# 02 — Arquitetura

## Objetivo arquitetural

O PulsoFinanceiro é um painel de leitura e interpretação: a Pluggy coleta os dados bancários, o backend os traz para um SQLite local, calcula métricas determinísticas e entrega contratos idênticos ao frontend e ao futuro consumidor Hermes.

Não existe caminho navegador → Pluggy, navegador → SQLite ou componente React → cálculo financeiro autoritativo.

## Diagrama textual

```text
                                      INTERNET

  Navegador
      │ HTTPS
      ▼
  Cloudflare Access (decisão canônica; implantação ainda não autorizada)
      │ JWT validado na borda e novamente no origin
      ▼
  pulso.cursar.space (proposto) ────┐
                                    │ Cloudflare Tunnel
  Pluggy webhook                    │
      │ HTTPS + Bearer              │
      ▼                             │
  pulso-hooks.cursar.space (proposto)┤
                                    ▼
                           127.0.0.1:3040
                    ┌────────────────────────────┐
                    │ Backend Node/TypeScript     │
                    │                            │
                    │ • API humana /api/v1       │
                    │ • webhook inbox            │
                    │ • API agente /api/agent/v1 │
                    │ • motor de métricas        │
                    │ • sanitizador de PII       │
                    │ • cliente Pluggy           │
                    │ • cliente OpenRouter       │
                    │ • SPA estática             │
                    └──────────────┬─────────────┘
                                   │ transações SQLite
                                   ▼
                    ┌────────────────────────────┐
                    │ pulso_financeiro.sqlite    │
                    │ WAL + FK + JSON1            │
                    │ dados, estado, inbox,       │
                    │ métricas derivadas, outbox  │
                    └────────────────────────────┘
                                   ▲
            systemd timers         │ mesma camada de domínio
      diário + semanal + backup ────┘

  Backend ──HTTPS──► Pluggy API
  Backend ──HTTPS──► OpenRouter (somente contexto agregado e sanitizado)
  Hermes ──token por principal──► /api/agent/v1 (fase posterior; agregado e versionado)
```

O diagrama mostra a **decisão canônica A**, não um estado implantado. A autorização humana continua obrigatória para executar F6:

- **A — Cloudflare Access, escolhida:** `pulso.cursar.space` passa por Tunnel + `Protect with Access` **e** o origin valida assinatura/claims do JWT; o host de webhook separado continua estreito e autenticado.
- **B — fallback Tailscale:** somente se A se tornar inviável; não existe hostname público humano. Um proxy autenticador externo da tailnet emite uma asserção curta e assinada que o origin valida. Não há token/sessão humana criado pelo PulsoFinanceiro.
- **C — aberto:** descartada. Aceite de risco não transforma URL pública em identidade e não protege as duas rotas de override.

Os dois hostnames acima são propostas livres no inventário de 24/08/2026; DNS, Tunnel e políticas ainda não existem e não são criados nesta rodada.

## Componentes

### 1. Frontend

- React, Vite e TypeScript.
- SPA servida pelo próprio backend no mesmo origin do site.
- Tema exclusivamente escuro, conforme `08-design-system.md`.
- TanStack Query para cache e invalidação dos contratos HTTP.
- Apache ECharts para gráficos com tema próprio.
- Camada 3D/WebGL carregada de forma lazy e descartável, sempre sobre contrato 2D/DOM completo; fallback é obrigatório em mobile limitado, redução de movimento, economia de dados e perda de contexto.
- Arquétipos funcionais traduzem leitura/proteção, pulso elétrico e celebração determinística; nomes/likeness/assets de *Jujutsu Kaisen* não chegam à release sem licença, usando mascotes originais por padrão.
- Não contém credenciais, SDK Pluggy, segredo OpenRouter nem lógica de cálculo autoritativa.
- Não contém login, cadastro, usuário, senha ou lançamento manual.

### 2. API humana `/api/v1`

- Lê métricas prontas do domínio e devolve JSON tipado.
- Exige identidade humana em toda rota: JWT do Access validado no origin na decisão A ou asserção assinada do proxy autenticador externo no fallback B. Nenhuma opção remove o gate.
- Expõe somente duas mutações financeiras: override de categoria e override de transferência interna.
- Aplica limites de período, paginação e tamanho de resposta antes de consultar o banco.
- Nunca aceita SQL, expressão de fórmula ou nome de coluna vindo do cliente.

### 3. Coletor Pluggy

- Obtém `apiKey` por `POST /auth`, mantém token apenas em memória e renova antes das 2 horas.
- Consulta o item e as contas antes de coletar.
- Colhe `/v2/transactions` por `accountId`, seguindo `next` como cursor opaco.
- Sincroniza categorias, faturas e snapshots de contas.
- Aplica UPSERT por `transaction.id`; uma transação `PENDING` que vira `POSTED` é atualização, não novo lançamento.
- Não chama endpoint para forçar atualização do item.

### 4. Webhook inbox

- Recebe somente `POST` no host dedicado.
- Autentica o header Bearer configurado na Pluggy, limita corpo e taxa e deduplica pelo `eventId`.
- Persiste o envelope sanitizado antes de responder.
- Responde `2xx` em menos de 5 segundos e processa depois.
- Trata o payload como sinal, não como verdade financeira: o worker consulta a Pluggy autenticada.
- Eventos `transactions/created`, `transactions/updated` e `transactions/deleted` acionam, respectivamente, coleta pelo link v2, busca por `ids` e tombstone local.

### 5. Motor de sincronização

Possui quatro modos com o mesmo código de domínio:

| Modo | Gatilho | Objetivo |
|---|---|---|
| `initial` | comando aprovado na implantação | carregar e filtrar localmente os últimos 12 meses |
| `webhook` | inbox persistida | refletir mudanças logo após a Pluggy |
| `incremental` | timer diário | colher por `createdAtFrom` com sobreposição e reparar webhook perdido |
| `reconciliation` | timer semanal ou comando sob demanda | comparar por cursor e reparar inserções, updates ou deletes omitidos |

Um lock de aplicação no banco impede dois modos de escrever simultaneamente. Falha em uma conta não avança o checkpoint global como se o ciclo inteiro tivesse concluído.

### 6. Motor de métricas

- É a única implementação das fórmulas de `09-telas-e-features.md`.
- Exclui tombstones e transferências internas conforme regra efetiva.
- Separa `POSTED` de `PENDING`; valores pendentes nunca são silenciosamente tratados como consolidados.
- Usa `amountInAccountCurrency` quando presente e cai para `amount` somente quando as moedas forem compatíveis.
- Todo envelope de métrica emite `computedAt`, `dataThrough`, `period`, `metricVersion`, `quality`, contagens de cobertura/amostra e moeda; cada valor que pode ser citado recebe `metricId`.
- Eventos operacionais carregam `eventId` e referências opcionais a métricas, mas não ganham `metricId` artificial.
- Produz os mesmos DTOs-base para painel, IA e Hermes.

### 7. Camada de IA

- O backend calcula; o modelo narra, explica ou sugere.
- Um sanitizador remove PII antes da montagem do contexto.
- Contextos contêm métricas, amostras mínimas e IDs internos efêmeros; não contêm dumps anuais.
- Structured output exige `metricRefs` em toda afirmação numérica.
- Falha da IA não bloqueia sincronização, painel nem alertas determinísticos.

### 8. Outbox Hermes

- Detectores persistem eventos com tipo, severidade, payload compacto, chave de deduplicação e estado.
- O backend não escolhe Discord, WhatsApp ou texto final.
- A primeira integração expõe snapshot de leitura e operações de `claim`/`ack` da outbox, autenticadas por escopos e lease; são escritas operacionais e não concedem escrita financeira.
- Detalhes em `14-integracao-hermes.md`.

### 9. Clarificação posterior pelo Hermes

- `UNKNOWN_TRANSACTION_NEEDS_CONTEXT` pode existir como evento read-only quando descrição e sinais normalizados não sustentarem classificação; a primeira integração não aceita resposta nem cria regra.
- Só numa fase posterior o Hermes escolhe um canal privado, pergunta por botões e resposta opcional e resolve pela API com principal que possua `clarifications:write`. O PulsoFinanceiro persiste evento/sugestões sanitizadas, mas não conhece Discord nem envia mensagem.
- A resolução usa `If-Match` e idempotency key, aceita somente sugestão de categoria existente ou alias normalizado curto e registra principal, versão e regra resultante.
- Esta é exceção explícita e tardia ao zero-input, somente fora do site. A API humana continua com apenas os dois overrides; a primeira integração Hermes continua sem escrita financeira.

## Organização lógica futura

A rodada de implementação deve manter limites de módulo, ainda que o deploy seja um único processo:

```text
frontend
backend/http
backend/domain
backend/metrics
backend/integrations/pluggy
backend/integrations/openrouter
backend/sync
backend/storage
backend/security
backend/agent-api
```

Isto é uma topologia, não autorização para criar esses diretórios nesta rodada.

## Escolha de monólito modular

Um serviço Node único reduz build, porta, túnel, configuração e observabilidade para um usuário e cerca de 2,1 mil transações anuais. Separar frontend, worker e API em containers criaria coordenação sem ganho de escala. As fronteiras internas e os comandos separados preservam a possibilidade de extrair um worker futuramente.

## Concorrência e consistência

- Uma transação externa é identificada pelo ID da Pluggy.
- Cada página é validada antes de abrir a transação SQLite de UPSERT.
- O checkpoint só avança depois do commit de todas as contas do ciclo.
- O cursor serve para continuar a requisição atual; não substitui o checkpoint temporal.
- Reprocessar a mesma página, webhook ou ciclo produz o mesmo estado final.
- WAL permite leitura do painel durante escrita curta; `busy_timeout` trata contenção transitória.
- Operações de schema ficam em migration transacional, jamais no startup silencioso.

## Fluxo de uma atualização automática

1. A Pluggy executa o auto-sync no próprio cronograma.
2. A Pluggy envia um evento com `triggeredBy=SYNC`.
3. O endpoint valida e persiste o evento, responde rapidamente e acorda o worker.
4. O worker consulta o estado atual do item.
5. Para criação, segue o link v2; para atualização, consulta por `ids`; para exclusão, grava tombstone.
6. O backend normaliza, remove PII proibida e faz UPSERT.
7. Detectores recalculam somente agregados afetados e escrevem a outbox se houver mudança relevante.
8. O frontend invalida os contratos afetados na próxima consulta; nenhuma notificação de canal é enviada pelo backend.

## Falhas isoladas

| Falha | Degradação esperada |
|---|---|
| Pluggy indisponível | mostra último estado confirmado e saúde degradada |
| webhook perdido | incremental diário e reconciliação semanal reparam |
| uma conta falha | outras podem ser coletadas, mas checkpoint global não fecha como sucesso completo |
| IA indisponível | métricas e alertas determinísticos permanecem |
| WebGL/asset 3D indisponível | fallback 2D preserva toda métrica, evidência e ação |
| Hermes indisponível | evento continua na outbox sem duplicar |
| identidade Access/fallback indisponível | dados não são liberados por confiar no loopback; sem identidade validada, a API humana falha fechada |

## Pendências / a confirmar

- Validar compatibilidade das versões exatas de Fastify, driver SQLite, React, Vite e ECharts com Node 22 antes de travar o lockfile.
- Autorizar operacionalmente a decisão A antes da F6 ou documentar por que ficou inviável e aprovar o fallback B; exposição aberta não é alternativa.
- No caminho A, aprovar a criação futura dos hostnames `pulso.cursar.space` e `pulso-hooks.cursar.space`; eles ainda não existem. No fallback B, nenhum hostname é criado.
- Aprovar licença aplicável para qualquer uso reconhecível de *Jujutsu Kaisen* ou confirmar os mascotes originais antes da F6; sem licença, nenhuma likeness/asset oficial entra.
- Manter `clarifications:write` fora da primeira integração Hermes e submetê-lo a gate próprio de privacidade, auditoria e canal privado.
- Definir se o worker de inbox será um laço interno curto ou uma unidade `systemd` ativada por evento; ambos devem usar o mesmo lock e os mesmos contratos.
