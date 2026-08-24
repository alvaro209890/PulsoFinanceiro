# 14 — Integração futura com o Hermes

## Objetivo e fase

Esta integração é planejada agora e implementada somente depois de o PulsoFinanceiro funcionar sozinho, sincronizar com segurança e calcular métricas estáveis.

Primeiro contrato: o Hermes lê agregados, consulta explicações e entrega alertas. Ele não cria, edita, recategoriza nem exclui dado financeiro. A clarificação privada descrita adiante é fase posterior, com outro escopo/gate, e não enfraquece essa regra inicial.

## Contexto da frota

O Hermes possui três corpos e 13 perfis/canais:

- `hermes-server`, 24/7 no mesmo PC do PulsoFinanceiro;
- `hermes-acer`, com WhatsApp somente de saída e perfis de trabalho;
- `hermes-windows`, com capacidades locais do Windows;
- chat web e Discord por perfil;
- Segundo Cérebro como memória compartilhada.

### Auditoria viva de 2026-08-24

A verificação foi estritamente read-only: nenhum serviço/timer/configuração foi alterado, nenhum segredo teve valor lido, nenhuma mensagem foi enviada e nenhum provider foi acionado. O estado observado foi:

| Corpo | Evidência viva | Risco/limite |
|---|---|---|
| `hermes-server` | v0.19.1; gateway e dashboard ativos; `:9119`; TLS persistente | timer de status Discord desabilitado; modelos/reasoning heterogêneos em relação ao vault |
| `hermes-acer` | v0.18.2; gateway e dashboard ativos; `:9119`; TLS persistente | heartbeat e checagem de perfis em `active (elapsed)`, sem próxima execução desde 22/08; presença congelada; gateway observado em cerca de 1,16 GB |
| `hermes-windows` | v0.20.4; gateway inicia no logon; tasks recentes com resultado zero; TLS persistente | sem dashboard/listener `:9119`; `.env` com herança e principals adicionais de leitura; continua “logon, não boot” |

As 13 rotas de perfil conferem com a topologia, os `.env` Linux estão em modo `600`, nenhum perfil secundário tem `DISCORD_BOT_TOKEN`/`API_SERVER_KEY` e as memórias observadas estão abaixo do teto. Houve 503, timeouts e erros de conexão de provider recentes; isso confirma que LLM nunca pode bloquear ingestão, conciliação, persistência ou reaplicação de regra. Conexão Discord é fortemente indicada pelos gateways/TLS/logs, mas entrega e permissão real do canal não foram provadas sem mensagem ativa.

Recomendação planejada, ainda não criada: novo perfil `financas` no `hermes-server` e canal privado dedicado `💰｜pulso-financeiro`. O server é 24/7 e fica junto do app/banco; o perfil terá principal próprio e nenhum segredo Pluggy. Clarificação normal trafega diretamente pela outbox/bridge desse perfil, sem criar cartão; Kanban fica reservado a exceção, dead letter ou handoff entre corpos.

Handoff entre perfis é feito por **Kanban**, nunca bot falando diretamente com bot. Por exemplo: o perfil financeiro no server persiste a necessidade de aviso; a entrega WhatsApp no acer vira cartão Kanban para o perfil responsável.

## Limite de responsabilidade

```text
PulsoFinanceiro                         Hermes
──────────────────────────────────     ───────────────────────────────
calcula métricas                       escolhe canal
detecta condição                       redige mensagem
persiste evento                        aplica horário/silêncio/digest
deduplica condição                     entrega por Discord/WhatsApp
expõe JSON compacto                    cruza com contexto autorizado
não conhece canal                      usa Kanban entre agentes
não escreve no vault                   segue lock/protocolo do vault
```

O backend nunca importa SDK Discord, WhatsApp ou lógica de perfil Hermes.

## Autenticação machine-to-machine

Caller inicial: um principal próprio do `Hermes-server`, usando `http://127.0.0.1:3040/api/agent/v1`. Loopback não concede acesso; token e escopo continuam obrigatórios. Cada corpo/perfil futuro recebe outro principal, sem token compartilhado.

### Emissão

1. gerar token aleatório de 32 bytes para um principal;
2. entregar o texto uma vez e armazená-lo apenas no secret store/`.env` privado daquele perfil como `PULSO_HERMES_API_KEY`;
3. criar uma linha no registry SQLite `service_principals`, persistindo somente `current_token_hash`, `next_token_hash`, `scopes_json`, estado e metadados de rotação/expiração/revogação;
4. comparar hash em tempo constante e registrar somente o ID local do principal;
5. testar chamada, falha sem token, falha com escopo insuficiente e isolamento entre dois principais.

### Escopos iniciais

| Escopo | Uso |
|---|---|
| `metrics:read` | fechamento, projeção, saúde, categorias e recorrências |
| `events:read` | obter snapshot read-only da outbox não terminal |
| `events:claim` | adquirir lease operacional para IDs escolhidos |
| `events:ack` | registrar entrega operacional idempotente |

`ai:query` entra em fase posterior. Na primeira integração não existe escopo de escrita financeira.

`clarifications:read_private` e `clarifications:write` entram somente em H5/F8, para o principal isolado de `financas` e após gate de canal privado, retenção, auditoria e rollback. O primeiro lê o contexto exato mínimo; o segundo resolve. Nenhum implica o outro e nenhum é concedido ao principal H1.

### Rotação e revogação

- rotação preenche `next_token_hash`, `rotation_started_at` e `current_accept_until`; atual e próximo coexistem somente na janela curta;
- o Hermes troca o token e, ao fim da janela, o próximo é promovido atomicamente a atual;
- revogação marca o principal inativo, registra `revoked_at` e invalida seus hashes sem afetar outros perfis;
- token nunca passa por Kanban, Discord, nota, log ou payload de erro.

## Contratos para agentes

Base: `/api/agent/v1`; detalhes em `07-api-interna.md`.

| Rota | Uso | Escopo |
|---|---|---|
| `GET /summary?period=YYYY-MM` | fechamento compacto | `metrics:read` |
| `GET /projection?month=YYYY-MM` | projeção e componentes | `metrics:read` |
| `GET /anomalies?since=&limit=` | achados determinísticos | `metrics:read` |
| `GET /events?cursor=&limit=` | snapshot read-only de `PENDING`/`LEASED` não terminais | `events:read` |
| `POST /events/claim` | claim atômico de `eventIds[]`, devolvendo `leaseToken` por evento | `events:claim` |
| `POST /events/:id/ack` | confirmar outcome com `leaseToken` e `deliveryId` | `events:ack` |
| `POST /query` | consulta natural allowlisted | `ai:query`, fase posterior |
| `GET /clarifications/:id` | obter contexto exato mínimo depois de selecionar canal privado | `clarifications:read_private`, somente H5/F8 |
| `POST /clarifications/:id/resolve` | aceitar sugestão/alias de contexto | `clarifications:write`, somente H5/F8 |

Todo agregado métrico contém `schemaVersion`, `computedAt`, `dataThrough`, `period`, `metricVersion`, `quality`, contagens e moeda. Cada valor citável recebe `metricId`; envelopes de evento usam `eventId` e não recebem `metricId` artificial. Nenhum endpoint de agente devolve raw JSON, lista anual de transações, CPF, número de conta/cartão, CNPJ ou segredo.

## Outbox persistente

A tabela canônica é `outbox_events`.

Campos funcionais obrigatórios:

| Campo | Regra |
|---|---|
| `id` | ID local opaco |
| `event_type` | enum versionado |
| `severity` | `INFO`, `WARNING`, `HIGH`, `CRITICAL` |
| `payload_json` | agregado compacto e sanitizado |
| `dedup_key` | única somente enquanto `condition_closed_at IS NULL` |
| `status` | `PENDING`, `LEASED`, `DELIVERED`, `DISMISSED`, `DEAD_LETTER` |
| `occurred_at` | instante da condição |
| `last_occurred_at`, `occurrence_count` | última observação e repetições no episódio ativo |
| `condition_closed_at` | recuperação/encerramento do episódio, independente da entrega |
| `available_at` | quando pode ser consumido |
| `lease_owner`, `lease_until`, `lease_token_hash` | posse temporária; token bruto só na resposta de claim |
| `attempts` | tentativas operacionais |
| `delivery_id`, `delivered_at` | confirmação idempotente de entrega |
| `dismissed_reason_code`, `dismissed_at` | decisão terminal allowlisted sem entrega |
| `last_error_code` | código sanitizado, nunca texto externo bruto |

A criação do evento ocorre na mesma transação SQLite que confirma a mudança de métrica. Falha de canal não desfaz dado financeiro.

## Catálogo inicial de eventos

| Tipo | Condição | Severidade exata v1 | Deduplicação ativa |
|---|---|---|---|
| `CREDIT_LIMIT_BAND_CHANGED` | uso cruza uma faixa para pior | 70–<85% `WARNING`; 85–<95% `HIGH`; ≥95% `CRITICAL` | conta + ciclo + nova faixa; fecha ao sair da faixa/ciclo |
| `BILL_DUE_SOON` | faltam 7, 3, 1 ou 0 dias | 7 `WARNING`; 3/1 `HIGH`; 0 `CRITICAL` | fatura + limiar de dias |
| `SYNC_STALE` | `STALE_POLICY_V1` satisfeita | 24–<72h `WARNING`; 72–<168h `HIGH`; ≥168h `CRITICAL` | item + bucket; fecha no harvest recuperado |
| `SYNC_RECOVERED` | sync volta após `SYNC_STALE` | `INFO` | incidente de staleness encerrado |
| `MONTH_SPEND_ANOMALOUS` | razão do ritmo, com denominador válido, supera faixa | 1,25–<1,50 `WARNING`; 1,50–<2,00 `HIGH`; ≥2,00 `CRITICAL` | mês + versão do detector + faixa |
| `RECURRENCE_PRICE_INCREASE` | valor excede o limiar de mediana/MAD definido | `WARNING` | série + ocorrência efetiva |
| `RECURRENCE_RESUMED_AFTER_GAP` | cobrança volta após duas ou mais cadências cobertas | `WARNING` | série + ocorrência de retorno |
| `POSSIBLE_DUPLICATE_CHARGE` | par mesmo merchant/valor em menos de 24h | `HIGH` | IDs locais ordenados do par |
| `TRANSACTION_ANOMALY` | `LOG_ZSCORE` passa do corte | 3–<4 `WARNING`; 4–<5 `HIGH`; ≥5 `CRITICAL` | transação + versão `LOG_ZSCORE` |
| `WEBHOOK_PROCESSING_DEAD` | inbox esgotou retries locais | `WARNING` | `eventId` do webhook |
| `MONTHLY_CLOSE_READY` | mês fechado e reconciliado | `INFO` | mês + versão das métricas |
| `CONSENT_OR_LOGIN_ACTION_REQUIRED` | item exige ação e não há sync válido | `HIGH` | item + código + episódio |
| `UNKNOWN_TRANSACTION_NEEDS_CONTEXT` | sinais normalizados não atingem confiança mínima | `INFO` | transação local + versão da fonte; read-only antes de H5/F8 |
| `CONTEXT_RULE_FIRST_APPLIED` | primeira reaplicação de uma regra de contexto, para rollback humano sem nova pergunta original | `INFO` | regra local + revisão da transação; ocorre uma vez por regra |

`STALE_POLICY_V1` é proposta calibrável e compartilhada com o widget de saúde: exige ausência de harvest posterior a `nextAutoSyncAt + 6h` e idade de `dataThrough` ≥24h; com `nextAutoSyncAt = null`, combina idade com status/erro do item. Alteração futura exige versão, telemetria e migração explícita.

Dedup não é “não enviar nunca mais”. Um índice parcial protege `dedup_key` somente no episódio ativo. Nova observação atualiza `last_occurred_at`/`occurrence_count`; entrega não fecha condição. O detector preenche `condition_closed_at` ao provar recuperação, e uma reincidência posterior cria novo `id`.

## Fluxo de entrega

1. Um sync ou cálculo detecta transição relevante e cria/atualiza o episódio ativo na mesma transação da métrica.
2. O Hermes chama `GET /events`; recebe snapshot read-only de eventos `PENDING` e `LEASED`, sem alterar estado. Cursor pagina apenas esse snapshot; um novo poll reinicia sem cursor para não perder lease expirado.
3. O Hermes escolhe IDs e chama `POST /events/claim` com `eventIds` e lease proposto de 120 segundos; o claim é all-or-none e exige `events:claim`.
4. A API marca `LEASED` e devolve uma vez `leaseToken`/`leaseUntil` por evento; o banco conserva apenas o hash do token.
5. O Hermes seleciona canal, idioma e forma conforme perfil e horário. Se outro corpo for necessário, cria cartão Kanban sem segredo ou payload sensível.
6. Depois da entrega, chama `ack` com `leaseToken`, `deliveryId` único e `outcome = DELIVERED`.
7. Se houver decisão terminal explícita de não entregar, usa `outcome = DISMISSED` e `reasonCode` obrigatório: `POLICY_SUPPRESSED`, `NO_AUTHORIZED_CHANNEL` ou `SUPERSEDED_BY_NEWER_EVENT`. `DISMISSED` não serve para falha transitória e não altera finanças.
8. Na primeira transição terminal, token inválido, expirado ou de outro principal falha sem modificar o evento. Depois do commit, replay do mesmo evento + principal + `deliveryId` + body normalizado retorna o terminal anterior mesmo com lease expirado; request divergente falha sem duplicar entrega.
9. Em falha transitória, não há ack: lease expirado volta a `PENDING`; após teto operacional, vai a `DEAD_LETTER` e gera saúde degradada.

## Avisos proativos

O texto é responsabilidade do Hermes, mas deve preservar:

- `metricRefs` quando citar número;
- data/frescor da base;
- severidade calculada pelo backend;
- linguagem curta e ação sugerida;
- nenhuma PII ou descrição crua em canal coletivo;
- link para o painel somente quando o canal for autorizado.

WhatsApp é somente saída no acer. Discord existe por perfil nos três corpos. O PulsoFinanceiro não assume que um canal está disponível; ele mantém a outbox.

## Planejamento financeiro pelo Hermes

O Hermes consome fechamento e projeção, não recalcula:

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

Dados são fictícios. Ao cruzar com memória pessoal, o Hermes deve manter a resposta no canal autorizado e não copiar transações para o vault.

## Consulta em linguagem natural

Fase posterior:

1. o usuário pergunta no chat Hermes;
2. o Hermes envia pergunta e período ao endpoint `POST /api/agent/v1/query`;
3. o backend converte a pergunta numa intenção allowlisted, busca métricas e monta contexto sanitizado;
4. a IA responde com `metricRefs`;
5. o Hermes apresenta a narrativa e a data de frescor.

O modelo não recebe SQL, credencial, raw JSON nem permissão para inventar consulta. Se a intenção não mapear a métricas existentes, a API retorna `METRIC_NOT_AVAILABLE`.

## Clarificação privada de transação — H5/F8

Na primeira integração, o evento pode ser lido como observabilidade, mas pergunta, resposta e resolução permanecem desabilitadas.

1. Um detector versionado confirma cobertura suficiente, mas descrição, merchant, alias e sinais normalizados não sustentam classificação; abre `transaction_clarifications` e `UNKNOWN_TRANSACTION_NEEDS_CONTEXT`.
2. O evento leva apenas `clarificationId`, `version`, `transactionId` local, direção, data civil, faixa de valor e `categorySuggestions[]`. Não leva descrição/merchant bruto, valor exato, PII, ID Pluggy, fingerprint nem canal.
3. O perfil `financas` escolhe o canal privado allowlisted e chama `GET /api/agent/v1/clarifications/:id` com `clarifications:read_private`. A resposta `no-store` acrescenta somente data, valor e moeda; não contém pista textual. O bridge a descarta da memória depois da mensagem. O PulsoFinanceiro não recebe nem persiste nome/ID do canal.
4. O Hermes apresenta sugestões como botões, resposta curta opcional e escolha “aplicar a semelhantes”. A resolução chama `POST /api/agent/v1/clarifications/:id/resolve` com `If-Match`, `Idempotency-Key`, `applyToSimilar` e `clarifications:write`.
5. A ação é uma union fechada: `ACCEPT_CATEGORY_SUGGESTION` referencia `suggestionRef` já emitida; `SET_NORMALIZED_ALIAS` aceita alias NFKC de 1–60 caracteres após denylist e pode combinar uma `suggestionRef` já emitida. Não existe texto livre como categoria, edição de valor/data ou SQL.
6. O backend valida `transaction_revision_key`, persiste principal/versão e outcome interno `CATEGORY_ONLY`, `CATEGORY_OVERRIDE` ou `NORMALIZED_ALIAS`. `applyToSimilar: true` cria regra somente quando CNPJ/descrição segura ou `SOURCE_FINGERPRINT_V1/HIGH` já foi oferecida; caso contrário retorna `SIMILAR_RULE_NOT_SAFE` e permite repetir com `false`.
7. A regra de contexto exige mesma conta, direção, moeda e gate de valor; fingerprint nunca sai do SQLite. Baixa confiança pergunta novamente.
8. Na primeira reaplicação, `CONTEXT_RULE_FIRST_APPLIED` informa “apliquei sua regra” e oferece corrigir sem perguntar novamente “o que é”. Decisão divergente atualiza a application e desativa a regra no mesmo commit; silêncio mantém a classificação sem loop.
9. Resolução, expiração ou nova versão fecha o episódio ativo; resposta stale não sobrescreve a fonte.

A mensagem opcional é dado não confiável: Hermes sanitiza antes do request; backend repete validação, não a envia a IA e não a grava em log/banco. Silêncio expira sem alterar a transação. Esta é a única exceção planejada ao zero-input e existe somente fora do site; não autoriza escrita financeira genérica.

## Fechamento mensal no Segundo Cérebro

Planejado para uma fase posterior à integração de leitura:

1. `MONTHLY_CLOSE_READY` é emitido apenas após reconciliação;
2. o Hermes gera um rascunho a partir do endpoint agregado;
3. o destino e o nível de detalhe passam por gate de privacidade;
4. o agente autorizado adquire lock com `VAULT_AUTOR`, faz patch cirúrgico, libera e commita pelo `lock.sh`;
5. a entrada de changelog leva autor e data, mais recente no topo.

**Risco:** o Segundo Cérebro não foi aprovado como destino de dados financeiros privados. Valores financeiros, hábitos e nomes não podem ser escritos ali enquanto não houver uma área realmente privada ou decisão explícita por um resumo não sensível. A primeira integração não escreve no vault.

## Versionamento e compatibilidade

- `/api/agent/v1` preserva campos existentes dentro da versão maior.
- Campos novos são aditivos.
- Mudança de semântica exige novo `metricVersion`; mudança incompatível de envelope exige `/v2`.
- O Hermes rejeita versão maior desconhecida e não tenta adivinhar.
- Fixtures de contrato são totalmente fictícias.

## Roadmap da integração

| Etapa | Entrega |
|---|---|
| H0 | outbox e detectores funcionando sem consumidor |
| H1 | principal/token, summary, snapshot/claim/ack de events no Hermes-server; leitura financeira e apenas escrita operacional da outbox |
| H2 | Discord e handoff Kanban para WhatsApp, com dedup e dead letter |
| H3 | consulta natural pelo chat, usando `ai:query` |
| H4 | planejamento e fechamento mensal; escrita no vault só após gate de privacidade |
| H5 | clarificação privada com principal `financas`, `clarifications:read_private` + `clarifications:write` e regra segura opcional; exceção posterior e auditável |

## Critérios de aceite

- Site e Hermes exibem o mesmo `metricId` e valor para o mesmo período.
- Token sem escopo recebe 403; revogar um principal não afeta os demais.
- `GET /events` não muda status; somente claim válido cria lease; primeiro ack exige seu `leaseToken` mais `deliveryId`, e replay idêntico após resposta perdida continua idempotente mesmo com lease expirado.
- Reprocessar evento não duplica alerta.
- Falha do WhatsApp não remove evento.
- Nenhum payload agente contém campos proibidos.
- Nenhum endpoint inicial altera `transactions`, `categories`, overrides, bills ou contas.
- Handoff entre corpos é observável no Kanban, não mensagem bot-a-bot.
- H1 não possui escopo de clarificação; em H5, canal não privado, escopo incorreto, versão stale, PII/segredo ou ação fora da union são rejeitados.
- Resolver novamente com a mesma idempotency key não duplica regra; `applyToSimilar` inseguro falha fechado; correção desativa a regra; expirar/silenciar não altera classificação.

## Pendências / a confirmar

- Aprovar ou substituir a recomendação de criar o perfil `financas` no Hermes-server e o canal privado `💰｜pulso-financeiro`; nada foi criado nesta rodada.
- Definir política de horário silencioso e quando Discord deve escalar para WhatsApp.
- Decidir um destino com privacidade aprovada ou um formato realmente não sensível antes de qualquer fechamento no Segundo Cérebro.
- Calibrar `STALE_POLICY_V1` e as faixas de severidade com telemetria antes de produção; qualquer mudança deve versionar a política.
- Manter H5 bloqueada até aprovar principal separado, os dois escopos, canal Discord privado, retenção, rollback de regra e testes de PII/If-Match/idempotência/fingerprint.
