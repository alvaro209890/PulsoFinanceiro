# Job de sincronização

## 1. Decisão

O PulsoFinanceiro adota uma arquitetura **webhook-first com fallback agendado e reconciliação periódica**:

1. webhooks colhem rapidamente criações, alterações e exclusões produzidas pelo auto-sync da Pluggy;
2. um job diário incremental usa `createdAtFrom` com overlap para recuperar criações cujo webhook tenha sido perdido;
3. uma reconciliação semanal pagina novamente o conjunto completo disponível por conta, corrigindo updates/deletes perdidos e drift local;
4. a carga inicial pagina os 12 meses disponibilizados pela Pluggy.

O job **nunca chama `PATCH /items/{id}` para forçar update**. A Pluggy atualiza o Item automaticamente e expõe `nextAutoSyncAt`; o serviço local apenas consulta o Item e colhe os produtos já atualizados.

Alternativas descartadas:

- polling puro: aumenta chamadas e latência e ignora que a Pluggy já publica eventos;
- somente webhook: não cobre evento perdido, endpoint temporariamente indisponível ou configuração acidentalmente desabilitada;
- filtro de “últimos 30 dias” na request: não existe no contrato medido. `createdAtFrom` filtra ingestão, não `transaction.date`;
- forçar update diário do Item: duplica uma responsabilidade que já é da Pluggy, pode encontrar limites de frequência e introduz falhas sem benefício.

## 2. Modos de execução

| fluxo | `trigger` | `mode` | transações | objetivo |
|---|---|---|---|---|
| carga inicial | `INITIAL` | `FULL` | cursor completo, sem filtro, conta por conta | carregar até 12 meses |
| webhook | `WEBHOOK` | `TARGETED` | link V2, IDs específicos ou tombstones | baixa latência |
| fallback diário | `SCHEDULED` | `INCREMENTAL` | `createdAtFrom = watermark - overlap` | recuperar novas ingestões perdidas |
| reconciliação semanal | `SCHEDULED` | `FULL` | cursor completo, sem early-stop | corrigir qualquer drift dentro da janela da Pluggy |
| full resync sob demanda | `ON_DEMAND` | `FULL` | mesmo algoritmo da reconciliação | diagnóstico/recuperação, sem entrada financeira manual |

Todo modo cria uma linha em `sync_runs` e uma linha por fonte em `sync_run_sources`. Jobs usam as tabelas e nomes definidos em `docs/05-modelo-de-dados.md`.

## 3. Invariantes

- todas as transações entram por `INSERT ... ON CONFLICT(id) DO UPDATE`; `id` é externo e o `public_id` ULID local é criado só no insert, preservado no update e usado pela API;
- a mesma página, evento ou execução pode ser repetida sem duplicar lançamento;
- `PENDING` e `POSTED` são estados do mesmo `transaction.id`; status, valor e metadados são atualizáveis;
- delete sempre cria/atualiza `transaction_tombstones`, inclusive para ID desconhecido; `deleted_at` na transação é apenas sua materialização e nunca há `DELETE` físico;
- um watermark só avança depois que todas as páginas daquela fonte forem validadas e commitadas;
- cursor `after` e `next` são opacos;
- cada conta possui paginação e watermark independentes;
- nenhuma métrica é recalculada sobre execução parcial sem ser marcada como desatualizada;
- JSON é sanitizado na denylist canônica de `docs/05-modelo-de-dados.md` antes de formar `raw_json_sanitized`, SQLite, logs/erros ou cache;
- o worker nunca depende de `total`, `totalPages`, `page` ou `pageSize` em `/v2/transactions`;
- não existe tabela `users` nem escopo por usuário.

## 4. Coordenação e concorrência

Somente uma coleta ampla (carga inicial, fallback diário, reconciliação semanal ou full resync `ON_DEMAND`) roda por Item. O worker adquire lease na linha `item:<ITEM_ID>` de `sync_state`, preenchendo `lease_owner` e `lease_until` por transação atômica.

- lease inicial: 10 minutos;
- renovação: a cada página concluída;
- processo só toma lease expirado mediante compare-and-swap no SQLite;
- o timer que encontrar lease válido encerra como `SKIPPED`, sem erro;
- o webhook sempre é aceito e persistido; se uma coleta ampla estiver ativa, o processamento aguarda na inbox;
- eventos repetidos do mesmo `eventId` não criam trabalho adicional;
- eventos distintos de criação/update da mesma conta podem ser coalescidos antes da leitura, preservando todos os IDs.

A implementação inicial processa contas sequencialmente. Com o volume atual, paralelizar traz pouco ganho e aumenta contenção no único writer SQLite. Otimização futura pode paralelizar apenas downloads, mantendo commits serializados.

## 5. Carga inicial de 12 meses

### Pré-condições

1. Obter API key em memória.
2. Executar `GET /items/<ITEM_ID>`.
3. Se o Item ainda estiver em execução, registrar o estado e reagendar; não iniciar outra atualização.
4. Persistir `status`, `executionStatus`, `lastUpdatedAt`, `nextAutoSyncAt` e `consentExpiresAt`.

### Algoritmo

```text
run_started_at = agora UTC
criar sync_run(trigger=INITIAL, mode=FULL, status=RUNNING)
adquirir lease do Item
endpoint = "https://api.pluggy.ai/v2/transactions"

sincronizar GET /categories
sincronizar GET /accounts?itemId=<ITEM_ID>

para cada conta ativa:
  se houver resume_next_query de FULL incompleto:
    reconciliation_epoch = epoch persistido
    current_url = endpoint + resume_next_query
  senão:
    reconciliation_epoch = novo ULID local
    current_url = endpoint + "?accountId=" + encodeURIComponent(<ACCOUNT_ID>)
  enquanto current_url existir:
    GET current_url
    validar response.results e response.next
    sanitizar todos os results
    em uma transação SQLite:
      para cada ID devolvido por esta leitura atual e autoritativa:
        limpar tombstone de modo auditável, se existir
        se transaction.date estiver na janela local de 12 meses:
          upsert por transaction.id preservando public_id
          marcar last_reconciliation_epoch = reconciliation_epoch
      persistir response.next, resume_run_id e reconciliation_epoch
      atualizar contadores e renovar lease
      incrementar data_revision uma vez se o commit mudou dado servido
    current_url = null se response.next for null; senão endpoint + response.next
  após response.next == null:
    concluir reconciliation_epoch
    limpar resume_next_query e resume_run_id
    created_at_watermark = run_started_at

para cada conta CREDIT/CREDIT_CARD:
  paginar GET /bills?accountId=<ACCOUNT_ID> com seu paginador legado

sincronizar /investments e /loans
gravar balance_snapshots, copiando a obrigação aberta em open_bill_*
executar derivados e eventos
marcar run SUCCEEDED e liberar lease
```

`response.next` precisa ser `null`/ausente ou começar por `?`. A implementação nunca faz `base_url + next_url`: usa o endpoint completo na primeira página e, nas demais, **`endpoint + response.next`**. URL absoluta, fragmento, path ou query sem `accountId` esperado é drift de contrato e não é seguida.

Não enviar `dateFrom`, `dateTo`, `from`, `to`, `page`, `pageSize` ou `limit` a `/v2/transactions`. Mesmo que apareça registro mais antigo, continuar a paginação até `next = null` e filtrar localmente pela janela civil de 12 meses; sem ordem confirmada, data antiga não autoriza parada. A Pluggy documenta recuperação de até 12 meses e o conjunto medido contém **2.088 transações em 6 páginas**: 1.829/4 páginas na conta corrente, 9/1 na poupança e 250/1 no cartão.

A carga inicial também espera 130 categorias, três contas, 12 faturas e coleções vazias de investimentos/empréstimos. Esses números são observabilidade, não asserts rígidos: divergência futura gera aviso de variação, não falha automática.

O `created_at_watermark` recebe `run_started_at`, e não o maior `createdAt` visto. Se a Pluggy ingerir um registro durante a carga, o overlap do próximo incremental o relê com segurança; o upsert elimina duplicação. Se o cursor full for rejeitado, a conta aborta o epoch incompleto, cria **novo `reconciliation_epoch`** no mesmo commit que limpa cursor/run de retomada e volta à primeira página sem filtro; nenhuma ausência é aplicada até completar o novo epoch.

## 6. Incremental diário por `createdAtFrom`

### Escolha e justificativa

O job diário usa a estratégia incremental por ingestão:

```text
createdAtFrom = último watermark bem-sucedido da conta - 10 minutos
```

O overlap de 10 minutos cobre diferença de relógio, commit no limite do instante e consistência eventual. Como toda gravação é upsert, reler poucos registros é barato e seguro. Se a conta ainda não tiver watermark, o job muda para carga completa dessa conta.

Se `sync_state.resume_next_query` já existir para um incremental interrompido, o novo run lê `resume_run_id`, adota `watermark_to` da fonte interrompida e continua em `endpoint + resume_next_query`. Ele não cria uma janela temporal nova no meio do cursor.

`createdAtFrom` não é data de compra. Uma transação antiga recém-ingerida será capturada; uma transação recente já conhecida pode não ser devolvida apenas por ter `updatedAt` novo. Por isso atualizações chegam por `transactions/updated`, e a reconciliação semanal corrige qualquer update perdido.

### Passos

1. Criar `sync_run(trigger=SCHEDULED, mode=INCREMENTAL)` e definir `watermark_to = run_started_at` antes da primeira request; numa retomada, adotar o `watermark_to` ligado a `resume_run_id`.
2. `GET /items/<ITEM_ID>` e persistir estado/`nextAutoSyncAt`.
3. `GET /accounts?itemId=<ITEM_ID>` e atualizar os três tipos de conta.
4. Sincronizar `GET /categories` antes das transações.
5. Para cada conta, iniciar com:

   ```http
   GET https://api.pluggy.ai/v2/transactions?accountId=<ACCOUNT_ID>&createdAtFrom=<WATERMARK_MENOS_10_MIN>
   ```

6. Seguir `next` até ausente/null. Cada página seguinte é `https://api.pluggy.ai/v2/transactions` + `response.next`; não reaplicar manualmente `createdAtFrom` nem concatenar outra base/path.
7. Como cada resultado veio de GET atual autoritativo, fazer upsert preservando `public_id` e, se houver tombstone ativo daquele ID, limpá-lo com run/reason auditáveis no mesmo commit. O envelope webhook sozinho nunca faz isso.
8. Em cada página, persistir `resume_next_query` e `resume_run_id`; só após a última, limpar ambos e gravar `created_at_watermark = watermark_to` e `sync_state.last_successful_at`.
9. Atualizar faturas, investimentos e empréstimos; gravar snapshot diário copiando `open_bill_*`, sem depender futuramente da linha mutável da fatura.
10. Recalcular somente derivados afetados, incrementar `system_state.data_revision` uma vez por commit visível e criar/atualizar eventos ativos na outbox.

O watermark é por conta. Se corrente e poupança concluírem e cartão falhar, somente as duas primeiras avançam; o run global fica `PARTIAL`. O próximo job repete o cartão desde seu watermark antigo.

`sync_state.last_successful_at` é a verdade por fonte. O último sucesso global é a linha mais recente `sync_runs.status = SUCCEEDED`; `items` não duplica esse instante. Um run `PARTIAL` não vira sucesso global, embora fontes concluídas conservem seus próprios avanços.

Embora a referência oficial atual cite `dateFrom` e `dateTo`, o tenant medido só confirmou `accountId`, `after`, `createdAtFrom` e `ids`. O incremental **não depende** dos filtros de data financeira até um teste exato no tenant aprová-los.

### Horário

O fallback roda uma vez por dia, depois da janela normal de auto-sync observada em `nextAutoSyncAt`, com margem inicial de 30 minutos. `nextAutoSyncAt` pode mudar; portanto, a configuração do timer deve ser revisada na implantação com observações de pelo menos sete dias. Se o horário informado estiver ausente ou atrasado, usa-se o horário diário fixo configurado e apenas se colhe o estado disponível — nunca se força update.

O fallback roda mesmo que webhooks tenham sido recebidos: em geral retornará zero ou poucos registros e também confirma contas, faturas, estado do Item e saúde da integração.

## 7. Webhook-first

### Recepção síncrona, trabalho assíncrono

O endpoint `POST /api/webhooks/pluggy` executa somente:

1. validar `Authorization: Bearer <PLUGGY_WEBHOOK_BEARER_TOKEN>`;
2. validar content type, tamanho e envelope;
3. sanitizar o envelope;
4. persistir envelope válido por `eventId`, com conflito condicional somente para linha `FAILED`;
5. responder `202` em menos de 5 segundos.

Todo acesso à Pluggy e todo cálculo ocorrem depois da resposta. O IP oficial `52.67.145.81` é allowlist adicional na borda, nunca substituto do Bearer. Não existe HMAC documentado; não inventar validação de assinatura.

`itemId` é obrigatório em `item/updated`; `itemId` e `accountId` são obrigatórios em todo `transactions/*`; updated/delete também exigem `transactionIds[]` não vazio. Bearer, método, content type, tamanho, JSON, schema, campo condicional, Item fora do escopo ou tipo de evento inválido recebem `4xx` e não criam linha. Para envelope válido, o padrão de escrita é:

```sql
INSERT INTO webhook_inbox (event_id, event_type, payload_json, status, attempts, received_at)
VALUES (?, ?, ?, 'RECEIVED', 0, ?)
ON CONFLICT(event_id) DO UPDATE SET
  status = 'RECEIVED',
  processing_started_at = NULL,
  next_attempt_at = excluded.received_at
WHERE webhook_inbox.status = 'FAILED';
```

A atualização preserva `attempts`, `received_at` e o primeiro `payload_json`. Conflito em `RECEIVED`, `PROCESSING`, `SUCCEEDED` ou `DEAD` não altera a linha e ainda recebe `202`; `DEAD` é reservado a processamento permanente de envelope válido.

A Pluggy pode entregar o mesmo `eventId` até nove vezes: três tentativas consecutivas, três após 15 minutos e três após 2 horas. A inbox torna essas reentregas inofensivas.

Antes de processar qualquer `transactions/*`, o worker confirma que `accountId` pertence ao `itemId` configurado. Conta ainda desconhecida dispara primeiro um refresh de `/accounts?itemId=...`; se continuar ausente ou fora do Item, o evento termina `DEAD` com `ACCOUNT_SCOPE_INVALID`, sem conta/tombstone fantasma, e a reconciliação cobre eventual drift.

### `item/updated`

O primeiro passo do worker é `GET /items/{itemId}`; não tomar decisão usando apenas o payload. Persistir o estado atual. `triggeredBy = SYNC` indica atualização automática.

Se o Item estiver apto, enfileirar refresh de contas, faturas, saldos, investimentos e empréstimos. Os eventos de transação cuidam das linhas; um pequeno atraso/coalescência evita baixar a mesma conta várias vezes numa rajada.

### `transactions/created`

1. Preferir `createdTransactionsLinkV2` quando presente.
2. Em aplicações novas, `createdTransactionsLink` já aponta para `/v2/transactions`; aceitá-lo somente se host, protocolo e path forem exatamente os permitidos.
3. Se só houver link legado `/transactions`, **não o seguir**. Construir `/v2/transactions` com `accountId` e `transactionsCreatedAtFrom` do evento; se o timestamp não existir, enfileirar incremental da conta a partir do watermark seguro.
4. Paginar por `endpoint + response.next` até o fim e fazer upsert. A resposta atual da leitura, não o envelope, pode limpar tombstone.

### `transactions/updated`

1. Deduplicar `transactionIds` dentro do evento e entre eventos coalescidos.
2. Dividir em lotes de no máximo **400 IDs**. A referência permite 500, mas 400 deixa margem de URL.
3. Para cada lote:

   ```http
   GET /v2/transactions?accountId=<ACCOUNT_ID>&ids=<ID_1>,<ID_2>,...
   ```

4. Não combinar `ids` com `createdAtFrom`.
5. Upsert das respostas atuais, preservando `public_id`; se o GET devolver ID tombstonado, limpar o tombstone de forma auditável no mesmo commit.
6. ID solicitado e ausente não é apagado imediatamente; registrar inconsistência e deixar a reconciliação confirmar, salvo evento explícito de delete.

### `transactions/deleted`

1. Deduplicar IDs.
2. Processar em lotes locais de até **1.000**.
3. Em uma transação SQLite, fazer upsert em `transaction_tombstones` para **todos** os IDs com `tombstone_source = WEBHOOK` e `deleted_event_id`.
4. Nos IDs já presentes em `transactions`, materializar `deleted_at`/`deleted_event_id`; ID desconhecido continua preservado na tabela independente, sem criar linha fantasma de transação.

O delete não chama a API e nunca remove fisicamente o histórico. Create/update atrasado não ressuscita nada por si: somente um GET atual que realmente devolva o ID limpa o tombstone.

## 8. Reconciliação semanal por cursor

A reconciliação é o fallback forte para:

- webhook de update/delete perdido;
- worker indisponível além das tentativas;
- mudança de ID tratada pela Pluggy como delete + create;
- bug ou interrupção entre páginas;
- drift causado por evolução aditiva do payload.

Para cada conta:

1. criar `sync_run(trigger=SCHEDULED, mode=FULL)` — ou `trigger=ON_DEMAND, mode=FULL` — e definir o limite recuperável de 12 meses;
2. se `sync_state` tiver cursor full incompleto, adotar seu `reconciliation_epoch` e montar `current_url = endpoint + resume_next_query`; senão, criar novo epoch ULID e usar `endpoint + "?accountId=..."`, sem filtro;
3. seguir todas as páginas até `response.next = null`, validando que cada próximo valor começa por `?`;
4. em cada commit, upsert por ID externo, preservar `public_id`, marcar `last_reconciliation_epoch = epoch` e persistir cursor + `resume_run_id` + epoch;
5. somente depois de todas as páginas concluírem, criar `transaction_tombstones(tombstone_source = RECONCILIATION)` para linha ativa dentro dos 12 meses cujo `last_reconciliation_epoch` não seja o epoch atual;
6. nunca tombstonar histórico local mais antigo que a janela recuperável da Pluggy apenas por ele não ter vindo;
7. atualizar `last_reconciled_at`, limpar cursor/run/epoch de retomada e concluir a fonte.

Se qualquer página falhar, não executar a etapa de ausência/tombstone. Um restart comum, com cursor ainda válido, retoma o **mesmo epoch**. A exceção é cursor full inválido: como a releitura recomeça na primeira página, o worker aborta o epoch antigo e cria outro antes de ler; caso contrário, uma linha marcada antes da invalidação e removida da fonte durante o intervalo escaparia do tombstone. As marcações antigas não precisam ser apagadas porque só o novo epoch concluído participa da comparação. No incremental, cursor inválido volta ao watermark confirmado menos overlap e adota novo `watermark_to`.

### Ordem e early-stop

Há indicação prática de que os resultados vêm em ordem decrescente de `date`, mas isso ainda não está confirmado no tenant. Portanto, a implementação atual **não faz early-stop** ao encontrar transação antiga.

O teste de confirmação deve, para cada tipo de conta:

- coletar todas as páginas de mais de uma execução;
- verificar monotonicidade não crescente de `date` entre e dentro das páginas;
- verificar `order` nos empates de data;
- repetir após um ciclo com transações `PENDING → POSTED`.

Mesmo após confirmar a ordem, a reconciliação completa pode continuar lendo todas as páginas para detectar ausências. A confirmação apenas autoriza uma rotina futura de resync por janela a parar cedo; ela não altera o incremental por `createdAtFrom`.

## 9. Faturas e demais produtos

`/bills` possui paginação antiga e não reutiliza o cursor V2. O coletor segue `page` até `totalPages`, fazendo upsert por `bill.id` e reconciliando `financeCharges`/`payments` dentro da fatura. A ausência de fatura não apaga transação.

Depois da releitura, executar o algoritmo versionado de `transaction_bill_payment_matches`: para cada `bill_payment`, procurar independentemente `BANK_DEBIT` e `CARD_CREDIT` por mesma moeda, valor absoluto exato e menor distância civil entre zero e um dia. Empate não é resolvido por descrição/`order`; fica sem match. Roles pareadas saem do gasto. Crédito de cartão não pareado permanece ajuste não classificado e degrada `quality` para `partial`, em vez de reduzir despesa por suposição.

O snapshot diário da conta `CREDIT` copia valor, vencimento, moeda, fonte e qualidade da obrigação aberta em `open_bill_*`. Se `/bills` fornecer a fatura, fonte `BILLS`/qualidade `COMPLETE`; fallback por transações é `TRANSACTIONS_FALLBACK`/`PARTIAL`; ausência é `UNAVAILABLE`. Jobs posteriores não reescrevem snapshots de dias anteriores, de modo que a série histórica não depende da linha mutável da fatura.

`/investments` e `/loans` retornam zero hoje. Uma coleção vazia é sucesso e atualiza `sync_state.last_successful_at` da fonte. Se futuramente vierem dados, passam por sanitização e upsert no schema já existente.

`/identity` não faz parte de nenhum modo de sincronização nesta fase.

## 10. Retentativas e classificação de falhas

### Chamadas à Pluggy

| erro | política |
|---|---|
| `401` | invalidar API key, renovar e repetir uma vez |
| `400`, `403`, `404` de contrato | não repetir cegamente; classificar, preservar watermark e alertar |
| `410` | erro permanente: endpoint legado foi chamado; abrir alerta crítico |
| `429` | respeitar `Retry-After`; sem header, backoff com jitter |
| `5xx`, timeout, DNS/conexão | até 5 tentativas com base 1, 2, 4, 8 e 16 segundos, jitter de ±25%, limite de 30 segundos |
| cursor inválido em `INCREMENTAL` | limpar cursor/run e reiniciar de `watermark confirmado - 10 minutos` |
| cursor inválido em `FULL` | abortar o epoch incompleto, limpar cursor/run, criar novo `reconciliation_epoch` atomicamente e voltar à primeira página sem filtro |

Chamadas são idempotentes e têm timeout explícito de conexão e resposta. Retry não atravessa indefinidamente o próximo ciclo; ao esgotar, o run termina `FAILED` ou `PARTIAL`.

### Worker da inbox

Falha depois do `202` atualiza `webhook_inbox` para `FAILED`, incrementa `attempts` e agenda retries locais em 1 min, 5 min, 15 min, 1 h e 6 h. Reentrega Pluggy faz o `ON CONFLICT ... WHERE status = 'FAILED'` antecipar o próximo processamento sem zerar `attempts`.

Depois do orçamento, somente envelope **válido** cuja falha seja determinística/permanente ou tenha sido classificada permanente pelo worker vai a `DEAD`; então cria `WEBHOOK_PROCESSING_DEAD` e a reconciliação cobre o drift. Erros síncronos de Bearer, parsing, tamanho, content type, schema ou evento recebem `4xx`, não são inseridos e jamais usam `DEAD`. O corpo inválido não é guardado.

## 11. Falha de sync e consentimento

`consentExpiresAt = null` significa “sem data disponível” para o projeto até confirmação específica do conector. Não gerar alerta de expiração inventado.

Sinais implementáveis:

- `status`/`executionStatus` de Item em erro;
- `lastUpdatedAt` atrasado em relação a `nextAutoSyncAt` mais tolerância;
- dois fallbacks diários consecutivos sem sucesso;
- produtos antes não vazios retornando todos vazios;
- falha `401`/`403` persistente;
- webhook sem evento bem-sucedido por período anormal, comparado ao fallback.

A Pluggy não repete automaticamente `LOGIN_ERROR` e remove o Item do auto-sync nessa condição. Para outros erros, a documentação descreve até cinco tentativas em intervalos de uma hora e posterior saída do auto-sync se todas falharem. Esses estados geram ação de reconexão; o job local não tenta contornar com update forçado.

Em falha:

1. preservar último dado válido;
2. não zerar saldos, contas ou séries por resposta vazia isolada;
3. marcar freshness e erro operacional;
4. criar evento deduplicado na outbox;
5. mostrar aviso de que pode ser necessário reconectar o Item;
6. nunca criar outro Item ou forçar update automaticamente.

Um único retorno vazio só se torna autoritativo após nova leitura bem-sucedida coerente ou reconciliação; isso evita apagar dados durante expiração/revogação, que a documentação informa poder produzir endpoints vazios.

## 12. Pós-processamento

Depois do commit de uma fonte bem-sucedida, o backend executa incrementalmente:

1. aplicar `category_overrides` por CNPJ/descrição normalizada e `transaction_alias_rules` pelo mesmo matcher; colisão entre regras ativas falha fechado e abre saúde operacional;
2. somente quando nenhum matcher tradicional elegível existir, calcular `SOURCE_FINGERPRINT_V1` e consultar `transaction_context_rules`; exigir regra ativa `HIGH`, mesma conta/direção/moeda/gate de valor e correspondência única. Sinais insuficientes, conflito ou tolerância excedida não aplicam nada;
3. ao casar uma context rule, persistir `transaction_context_rule_applications`, aplicar categoria/alias e incrementar `match_count` no mesmo commit. Na primeira aplicação, criar uma única revisão `CONTEXT_RULE_REVIEW`/`CONTEXT_RULE_FIRST_APPLIED`; uma correção vigente desativa a regra e corrige a aplicação atomicamente;
4. marcar transferência interna por raiz `04` e aplicar a heurística canônica de pareamento um-para-um definida em `docs/05-modelo-de-dados.md` — contas distintas do mesmo Item, sentidos opostos, mesma moeda, tolerância de uma unidade mínima e janela de 24 horas, sem aceitar candidatos ambíguos;
5. recalcular `transaction_bill_payment_matches` pelo algoritmo exato de pagamento/moeda/valor/data, excluindo as duas roles do gasto;
6. atualizar grupos e ocorrências recorrentes, persistindo regularidade, estabilidade, hiato, retomada e versão do algoritmo;
7. detectar transações que precisam de contexto, duplicadas, reajustes, anomalias e faixas de limite;
8. recalcular métricas afetadas por conta/mês/categoria e sua qualidade;
9. persistir eventos agregados e sanitizados em `outbox_events`, respeitando a unicidade parcial enquanto a condição estiver aberta;
10. incrementar `system_state.data_revision` no mesmo commit de cada alteração visível.

### Clarificação futura via Hermes privado

Uma transação ativa `POSTED`, não classificada e sem descrição/merchant/sinais suficientes pode criar uma única `transaction_clarifications` para a versão atual. A pergunta contém apenas `public_id` local, reason codes fechados e no máximo três categorias sugeridas; PII, texto cru e IDs externos não saem. O evento é:

```text
UNKNOWN_TRANSACTION_NEEDS_CONTEXT:<TRANSACTION_PUBLIC_ID>:<SOURCE_UPDATED_AT_OR_LOCAL_REVISION>
```

Essa é a `dedup_key`; reprocessar a mesma versão não duplica, enquanto uma mudança real em `source_updated_at` pode pedir novo contexto. Na primeira fase Hermes, o evento é apenas leitura/alerta e nenhuma resposta é aceita. Uma fase posterior, com gate próprio, pode conceder a um principal privado `clarifications:read_private` para buscar data/valor/moeda mínimos em rota `no-store` e `clarifications:write` para resolver. Botão/categoria aplica `local_category_id`; resposta opcional define alias. Repetições usam primeiro `category_overrides`/`transaction_alias_rules` quando houver CNPJ ou descrição segura e, quando ambos faltarem, somente `transaction_context_rules` com `SOURCE_FINGERPRINT_V1`, alta confiança e `applyToSimilar: true`. Sem matcher, a resolução fica na transação atual. Texto livre é sanitizado, normalizado e descartado; fingerprint nunca sai do SQLite.

Na primeira reaplicação de uma context rule, o evento informativo usa chave ativa `CONTEXT_RULE_FIRST_APPLIED:<RULE_ID_LOCAL>:<TRANSACTION_REVISION_KEY>`. Ele informa a categoria/alias aplicado e oferece “corrigir” em canal privado; não volta a perguntar o que era a transação. Uma correção resolve a clarificação de revisão ligada a `source_context_rule_id`; expirá-la preserva a classificação e não gera loop de alerta.

O backend não possui coluna de canal; Hermes decide Discord privado ou outro transporte autorizado. Essa escrita futura não cria nem edita lançamento financeiro e é exceção explícita apenas na API de agente: o site continua zero-input.

O pós-processamento não faz parte do commit de ingestão. Se falhar, os dados brutos normalizados continuam válidos e o cálculo pode ser repetido. O status do run distingue ingestão concluída de derivados pendentes.

## 13. Logs e observabilidade

Cada `sync_run` fornece ao widget de saúde:

- último sync bem-sucedido;
- próximo `nextAutoSyncAt` informado pela Pluggy;
- estado atual do Item;
- quantidade recebida, inserida, atualizada e tombstonada;
- páginas lidas por conta;
- quantidade atual de `PENDING`;
- duração, tentativas e fontes com falha.

Logs estruturados contêm `run_id`, modo, fonte com alias opaco, página ordinal, contadores, status HTTP, latência e código de erro. Não contêm:

- API key, Bearer, headers ou URL com query/cursor;
- `itemId`, `accountId` ou `transactionId` em texto aberto;
- CPF, CNPJ, nome, descrições, payload ou valores monetários;
- JSON de transação ou resposta da Pluggy.

IDs completos permanecem somente nas tabelas locais necessárias à integração.

## 14. Critérios de aceite

### Carga e cursor

- carregar as três contas medidas e as seis páginas sem chamar `/transactions`;
- provar que cada próxima URL é exatamente o endpoint V2 + `response.next`, sem duplicar path/query;
- interromper entre páginas, retomar com `resume_run_id` e terminar sem duplicatas;
- no full, provar que retomada com cursor válido conserva o epoch; cursor inválido cria novo epoch e detecta ausência de linha marcada somente no epoch abortado; no incremental, provar retorno ao watermark-overlap;
- provar que `next = null` encerra a conta.

### Upsert e eventos

- ingerir uma transação `PENDING`, reapresentá-la `POSTED` com valor diferente, manter uma linha e o mesmo `public_id`;
- entregar duas vezes o mesmo `eventId` e executar um único efeito; reentrega só reabre `FAILED` pelo conflito condicional;
- processar create, update em lote e delete conhecido/desconhecido com tombstone independente;
- provar que evento atrasado não ressuscita e que somente GET atual autoritativo limpa tombstone;
- receber webhook e responder `202` antes de 5 segundos mesmo com worker pausado;
- rejeitar Bearer inválido/payload malformado acima do limite sem inserir inbox nem criar `DEAD`;
- parear `BANK_DEBIT`/`CARD_CREDIT`, excluir matches do gasto e degradar crédito não pareado/ambiguidade para `partial`;
- preservar `open_bill_*` de snapshot anterior após a fatura mudar;
- concluir timer concorrente como run `SKIPPED` e obter último sucesso global somente de `sync_runs`.

### Recuperação

- perder intencionalmente um webhook de criação e recuperar pelo fallback diário;
- perder update/delete e recuperar pela reconciliação semanal;
- simular `429`, `5xx`, cursor inválido e restart de processo sem avançar watermark incorretamente;
- falhar uma conta e concluir as demais com run `PARTIAL`;
- retornar coleção vazia de investments/loans sem quebrar UI;
- gerar no máximo uma `UNKNOWN_TRANSACTION_NEEDS_CONTEXT` por transação/versão, sem valor exato/ID externo/PII, provar que valor exato exige a rota privada separada e que a fase Hermes inicial não aceita resposta;
- provar que nenhum modo chama `PATCH /items/{id}`.

### Privacidade

- usar canários em payer/receiver `documentNumber` e nas chaves `owner`, `taxNumber`, `number`, `cardNumber`, `identificationNumber` e `identity`; comprovar remoção fail-closed antes de `raw_json_sanitized`, SQLite, log/cache/erro;
- comprovar que `merchant.cnpj` pode sustentar regra local, mas não aparece em log, contexto de IA ou outbox;
- varrer banco de teste e artefatos gerados atrás das chaves proibidas.

## Pendências / a confirmar

- **Gate de segurança:** antes de testar qualquer job/webhook, rotacionar as credenciais expostas no canal de planejamento; nenhuma API key efêmera colada pode ser reutilizada, e nenhum valor deve entrar em arquivo, log ou comando.
- Manter `clarifications:read_private` e `clarifications:write` desabilitados na primeira integração Hermes; habilitação futura exige gate explícito de privacidade, principal isolado, botões/alias, regra `SOURCE_FINGERPRINT_V1` e auditoria.
- Observar `nextAutoSyncAt` por pelo menos sete dias para fixar o horário do timer diário e sua margem sem competir com o auto-sync.
- Confirmar no tenant a ordem decrescente por `date` e o uso de `order` nos empates; até lá, early-stop permanece proibido.
- Testar `dateFrom`/`dateTo` no tenant antes de qualquer otimização, apesar de constarem na referência oficial atual.
- Confirmar a origem da expiração de consentimento do MeuPluggy quando `consentExpiresAt` vier `null`.
- Definir o limiar operacional exato para “sync atrasado” depois de medir a variação real entre `nextAutoSyncAt`, `lastUpdatedAt` e chegada dos webhooks.
