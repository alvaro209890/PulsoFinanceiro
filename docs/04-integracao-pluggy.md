# Integração com a Pluggy

## 1. Regra de autoridade

Este contrato combina o comportamento medido no tenant em **24/08/2026** com a documentação oficial consultada na mesma data. Quando houver divergência, vale o comportamento medido até um novo teste controlado no tenant provar o contrário.

Consequências práticas:

- o backend é o único componente que fala com `https://api.pluggy.ai`;
- o frontend nunca recebe `PLUGGY_CLIENT_SECRET`, API key nem IDs da Pluggy; contas e transações saem da camada de integração apenas pelos `public_id` ULID locais definidos no modelo;
- o endpoint legado `GET /transactions` é considerado indisponível: no tenant ele responde **HTTP 410**;
- toda leitura de transações usa `GET /v2/transactions`, conta por conta;
- a Pluggy já atualiza o Item automaticamente e informa `nextAutoSyncAt`; o PulsoFinanceiro **nunca força `PATCH /items/{id}` para sincronizar**. Ele apenas colhe o que a Pluggy trouxe;
- webhooks são o caminho primário e a coleta agendada é o fallback contra webhook perdido.

## 2. Configuração e segredos

Os valores ficam somente no ambiente do servidor, fora do Git:

| Variável | Conteúdo | Consumidor |
|---|---|---|
| `PLUGGY_CLIENT_ID` | identificador da aplicação Pluggy | backend |
| `PLUGGY_CLIENT_SECRET` | segredo da aplicação Pluggy | backend |
| `PLUGGY_ITEM_ID` | Item já conectado | backend |
| `PLUGGY_WEBHOOK_BEARER_TOKEN` | segredo aleatório usado para autenticar o webhook de entrada | backend e configuração de headers do webhook na Pluggy |

Os documentos, exemplos, logs, respostas de API e mensagens de erro nunca mostram os valores. O repositório público usa apenas marcadores como `<ITEM_ID>` e `<ACCOUNT_ID>`.

## 3. Autenticação servidor a servidor

### Contrato

```http
POST https://api.pluggy.ai/auth
Content-Type: application/json

{"clientId":"<PLUGGY_CLIENT_ID>","clientSecret":"<PLUGGY_CLIENT_SECRET>"}
```

A resposta contém `apiKey`, um JWT válido por **2 horas**. As chamadas seguintes enviam:

```http
X-API-KEY: <API_KEY_EM_MEMORIA>
```

### Política do cliente

1. Manter uma única API key em memória do processo, nunca no SQLite, disco, log ou frontend.
2. Registrar em memória o instante de expiração lido do JWT, sem registrar o token.
3. Renovar proativamente quando faltarem 10 minutos para expirar.
4. Proteger a renovação com uma promessa/lock compartilhado para impedir várias chamadas concorrentes a `/auth`.
5. Diante de `401`, invalidar o cache, renovar uma vez e repetir a chamada original uma vez. Um segundo `401` encerra o ciclo como falha de credencial; não entra em loop.

## 4. Item e ciclo automático

`GET /items/<ITEM_ID>` é lido no início de cada coleta agendada e ao processar qualquer evento de Item. Persistir somente os campos operacionais necessários: `status`, `executionStatus`, `lastUpdatedAt`, `nextAutoSyncAt`, `consentExpiresAt` e erro sanitizado, quando houver.

`nextAutoSyncAt` é informação de observabilidade e agendamento local; não é autorização para iniciar um update. O job local aguarda a atualização automática da Pluggy e coleta os produtos disponíveis.

No webhook, `triggeredBy: "SYNC"` identifica um evento causado pelo auto-sync. Mesmo assim, o payload é apenas um aviso: em qualquer evento de Item, a primeira operação assíncrona é `GET /items/{id}`, conforme a orientação oficial, e a decisão usa o estado atual retornado por esse GET.

No ciclo automático documentado pela Pluggy, `LOGIN_ERROR` não recebe nova tentativa automática e retira o Item do auto-sync. Outros erros podem receber até cinco tentativas com intervalo de uma hora; esgotadas, o Item também sai do auto-sync. O PulsoFinanceiro deve tornar essa condição visível e pedir reconexão, nunca tentar compensá-la forçando update.

## 5. Contas

`GET /accounts?itemId=<ITEM_ID>` retornou três contas no teste real:

| `type` | `subtype` | quantidade | campos específicos usados |
|---|---|---:|---|
| `BANK` | `CHECKING_ACCOUNT` | 1 | `bankData.closingBalance`, `automaticallyInvestedBalance`, `overdraftContractedLimit`, `overdraftUsedLimit` e `unarrangedOverdraftAmount` |
| `BANK` | `SAVINGS_ACCOUNT` | 1 | os mesmos campos de `bankData` |
| `CREDIT` | `CREDIT_CARD` | 1 | `creditData.level`, `brand`, `creditLimit`, `availableCreditLimit`, `balanceDueDate`, `minimumPayment` e `disaggregatedCreditLimits[]` |

Campos de alto risco (`number`, `owner`, `taxNumber` e o identificador dentro de `disaggregatedCreditLimits[]`) foram observados nessa resposta. A resposta inteira passa pela **única denylist canônica** de `docs/05-modelo-de-dados.md` antes do mapeamento; este documento não mantém uma segunda lista. Nada removido é persistido, nem mesmo ofuscado.

No tenant, `name` trouxe o rótulo da instituição nas contas bancárias e o nível do produto no cartão; os valores pessoais não são reproduzidos no repositório público. O rótulo local da conta é derivado de `type`, `subtype`, `name` e `marketingName` depois de remover sequências com aparência de número de conta/cartão. `account.id` continua sendo a chave externa de upsert e chamada Pluggy, guardada somente no banco; a API usa um `public_id` ULID local, aleatório e estável.

## 6. Transações: contrato medido de `/v2`

### Endpoint antigo proibido

`GET /transactions` respondeu **HTTP 410** no tenant. Embora partes da documentação ainda descrevam esse endpoint como “deprecated”, nenhuma implementação, fallback ou teste deve chamá-lo.

### Endpoint canônico

```http
GET https://api.pluggy.ai/v2/transactions?accountId=<ACCOUNT_ID>
X-API-KEY: <API_KEY_EM_MEMORIA>
```

O endpoint é executado separadamente para cada conta. Não existe consulta por `itemId`.

Parâmetros aceitos no teste real:

| parâmetro | regra |
|---|---|
| `accountId` | obrigatório; UUID da conta |
| `after` | cursor opaco da próxima página |
| `createdAtFrom` | instante de ingestão na Pluggy, não data financeira da transação |
| `ids` | lista de IDs para reler transações específicas |

Parâmetros rejeitados com **HTTP 400** no tenant: `from`, `to`, `page`, `pageSize`, `limit` e `itemId`.

A referência oficial também lista `dateFrom` e `dateTo` para `/v2/transactions`. **Testado no tenant em 24/08/2026 (rodada Hermes-server): HTTP 200 confirmado**, com filtro semântico por `date` da transação. Uso permitido como **otimização de janela** no harvest diário — mas a regra de autoridade permanece: o job nunca depende só do filtro de data; `createdAtFrom` + overlap + reconciliação full semanal continuam obrigatórios, porque o filtro por `date` não protege contra registros re-ingeridos (`createdAt` novo com `date` antigo).

Parâmetros rejeitados com **HTTP 400** no tenant: `from`, `to`, `page`, `pageSize`, `limit` e `itemId` (reconfirmado em 24/08/2026). `order` também é rejeitado (HTTP 400) — não existe controle de ordenação.

### Ordenação medida

Confirmado no tenant (24/08/2026): a resposta vem em **ordem decrescente de `date`**. Como não há parâmetro `order`, essa ordenação é observada, não garantida contratualmente; o upsert idempotente por `transaction.id` torna a aplicação correta mesmo se a ordem mudar. Continua proibido "parar cedo" ao encontrar data antiga — paginação termina apenas em `next` ausente/null.

### Paginação por cursor

Resposta fictícia:

```json
{
  "results": [
    {"id":"<TRANSACTION_ID>","accountId":"<ACCOUNT_ID>","amount":42.75}
  ],
  "next": "?accountId=<ACCOUNT_ID>&after=<CURSOR_BASE64>"
}
```

Regras obrigatórias:

- cada página contém até **500 registros**; o tamanho é fixo no comportamento medido e não é configurável;
- não existem `total`, `totalPages` ou `page`;
- `next` é uma query string pronta. Definir uma vez `endpoint = "https://api.pluggy.ai/v2/transactions"`; a primeira URL é `endpoint + "?accountId=..."` e toda URL seguinte é **exatamente** `endpoint + response.next`;
- `next` ausente ou `null` encerra a paginação;
- `after` é opaco: não decodificar, alterar, ordenar nem fabricar;
- `response.next` precisa começar por `?`; rejeitar URL absoluta, fragmento ou path. Não concatenar `base_url + next_url` nem reaplicar parâmetros do primeiro request;
- ao seguir um link inicial recebido em webhook, aceitar apenas host `api.pluggy.ai`, HTTPS e caminho `/v2/transactions`, evitando SSRF; depois disso, aplicar a regra fixa de `endpoint + response.next`;
- clientes JSON devem ignorar campos novos desconhecidos, preservando compatibilidade aditiva.

### Semântica de data

`createdAtFrom` filtra `createdAt`, isto é, **quando a Pluggy ingeriu o registro**. Não filtra `transaction.date`. Num Item recém-criado, todo o histórico pode ter `createdAt` do dia da conexão.

Portanto, a “janela móvel de 30 dias” não pode ser implementada como filtro de request no contrato medido. O job diário usa `createdAtFrom` com overlap e upsert; a reconciliação semanal pagina todo o conjunto disponível. A estratégia completa está em `docs/06-job-de-sincronizacao.md`.

Não se assume que a resposta venha em ordem decrescente de `date`. Até confirmar isso no tenant, nenhum paginador pode parar cedo ao encontrar uma data antiga. Se a ordem for testada, `order` deve desempatar registros com a mesma `date`.

### Campos normalizados

Todos estes campos foram observados e devem ser aceitos pelo mapeador:

`id`, `description`, `descriptionRaw`, `currencyCode`, `amount`, `amountInAccountCurrency`, `date`, `category`, `categoryId`, `balance`, `accountId`, `providerCode`, `status`, `paymentData`, `type`, `operationType`, `operationTypeAdditionalInfo`, `creditCardMetadata`, `merchant`, `providerId`, `order`, `createdAt` e `updatedAt`.

Valores observados relevantes:

- `status`: `POSTED` ou `PENDING`;
- `type`: `DEBIT` ou `CREDIT`;
- `operationType` em conta bancária: `PIX`, `BOLETO`, `CONVENIO_ARRECADACAO`, `DEPOSITO` e `OUTROS`; no cartão veio `null`;
- `order`: inteiro usado como desempate dentro da mesma data;
- `creditCardMetadata`: `payeeMCC` auxilia categorização e `billForecastDate` liga a compra à fatura prevista;
- `merchant`: pode conter `cnpj`, `cnae`, `category` e `businessName`;
- `paymentData.payer.documentNumber.value`: contém CPF em texto puro e deve ser removido.

O objeto inteiro passa pela denylist canônica antes de gerar `raw_json_sanitized` ou colunas normalizadas. Ela cobre inclusive documento de payer/receiver e identificadores que apareçam em profundidade inesperada. `merchant.cnpj` pode ficar no SQLite local para agrupamento e regras, mas nunca é enviado à IA, escrito em logs, exemplos, exports ou repositório.

Na fase futura de clarificação, somente os campos observados e já normalizados podem alimentar a allowlist de `SOURCE_FINGERPRINT_V1` definida em `05-modelo-de-dados.md`. A representação canônica veda `id`, `providerId`, data, saldo, valor, descrição/texto bruto, nomes, documentos e qualquer PII; valor permanece gate separado. A fingerprint é derivado local de sincronização, não campo Pluggy, e nunca volta para request, DTO, evento, log, IA, Discord ou vault.

O volume de 12 meses medido foi de **2.088 transações em 6 páginas**: 1.829 da conta corrente, 9 da poupança e 250 do cartão. Havia 21 transações de cartão em `PENDING`; por isso toda escrita é um upsert por `transaction.id`, capaz de substituir status, valor e demais campos mutáveis quando virarem `POSTED`. O conflito pelo ID externo preserva o `public_id` local já existente; o ID externo nunca é aceito nas rotas da aplicação.

## 7. Categorias

`GET /categories` retornou **130 categorias**, hierárquicas e traduzidas, com:

```json
{
  "id":"08040000",
  "description":"Clothing",
  "descriptionTranslated":"Vestuário",
  "parentId":"08000000",
  "parentDescription":"Shopping"
}
```

O backend sincroniza a tabela `categories` e a UI usa `descriptionTranslated`; não há catálogo ou tradução manual. O rollup de nível 1 usa os dois primeiros dígitos de `categoryId`. As 22 raízes observadas são:

| prefixo | rótulo traduzido observado |
|---|---|
| `01` | Renda |
| `02` | Empréstimos e financiamento |
| `03` | Investimentos |
| `04` | Transferência mesma titularidade |
| `05` | Transferências |
| `06` | Obrigações legais |
| `07` | Serviços |
| `08` | Compras |
| `09` | Serviços digitais |
| `10` | Supermercado |
| `11` | Alimentos e bebidas |
| `12` | Viagens |
| `13` | Doações |
| `14` | Apostas |
| `15` | Impostos |
| `16` | Taxas bancárias |
| `17` | Moradia |
| `18` | Saúde |
| `19` | Transporte |
| `20` | Seguros |
| `21` | Lazer |
| `99` (`99999999`) | Outros |

`categoryId` começando por `04` é o sinal primário de transferência entre contas da mesma titularidade. A heurística de valores espelhados, janela temporal e contas do mesmo Item atua somente como reforço quando a Pluggy não aplicar essa raiz.

## 8. Faturas de cartão

`GET /bills?accountId=<ACCOUNT_ID>` retornou 12 faturas. Esse endpoint usa a paginação antiga, com `total`, `totalPages` e `page`; ele **não compartilha** o paginador de `/v2/transactions`.

Campos persistidos:

- `id`, `dueDate`, `billClosingDate`;
- `totalAmount`, `totalAmountCurrencyCode`;
- `minimumPaymentAmount`, `allowsInstallments`;
- `financeCharges[]`, incluindo `type`, `amount`, `currencyCode` e `additionalInfo`;
- `payments[]`, quando presentes.

`financeCharges.type = IOF` foi observado. As faturas são reconsultadas em toda coleta diária e conciliadas por `bill.id`; encargos e pagamentos também usam upsert. Não inferir fechamento ou vencimento a partir de transações quando o dado da fatura estiver disponível. A ligação de `payments[]` com débito bancário/crédito do cartão usa `transaction_bill_payment_matches`, algoritmo de valor/moeda/data e regra de ambiguidade de `docs/05-modelo-de-dados.md`; não se presume que qualquer crédito seja estorno.

## 9. Investimentos, empréstimos e identidade

`GET /investments?itemId=<ITEM_ID>` e `GET /loans?itemId=<ITEM_ID>` retornaram zero registros, embora os produtos estejam habilitados. O backend continua consultando-os no ciclo completo, persiste listas futuras e devolve coleção vazia sem tratar isso como erro.

`GET /identity` devolve CPF e data de nascimento. Não há caso de uso aprovado para esses dados; portanto, **o PulsoFinanceiro não chama esse endpoint nesta fase**. Se surgir um uso real, será necessário novo ADR e revisão de ameaça antes de habilitá-lo.

## 10. Webhooks

### Escolha de configuração

Usar webhook no nível da aplicação por `POST /webhooks`, com os headers configurados pela API da Pluggy. Não configurar ao mesmo tempo o `webhookUrl` específico do Item: as duas modalidades juntas entregariam eventos duplicados.

Configuração ilustrativa, sem segredo real:

```json
{
  "url":"https://pulso-hooks.cursar.space/api/webhooks/pluggy",
  "event":"transactions/created",
  "headers":{"Authorization":"Bearer <PLUGGY_WEBHOOK_BEARER_TOKEN>"}
}
```

Criar inscrições para exatamente estes eventos nesta fase:

- `item/updated`;
- `transactions/created`;
- `transactions/updated`;
- `transactions/deleted`.

O Bearer compartilhado é a autenticação primária. A Pluggy não documenta assinatura HMAC para esses webhooks, então **não se inventa HMAC** nem se trata o corpo como assinado. O IP oficial `52.67.145.81` pode ser permitido na borda como defesa adicional; ele não substitui o Bearer, e o backend não confia em `X-Forwarded-For` fornecido livremente pelo cliente.

### Recepção

1. Exigir HTTPS e `Authorization: Bearer ...`, comparado em tempo constante.
2. Limitar método, content type e tamanho do corpo; Bearer, parse, schema ou evento inválido recebem `4xx` e não criam linha.
3. Exigir `itemId` em `item/updated` e `itemId` + `accountId` em todo `transactions/*`; `transactions/updated|deleted` exigem `transactionIds[]` não vazio. Rejeitar Item diferente do único configurado. A pertença da conta ao Item é validada pelo worker com leitura atual antes de mutar dados.
4. Para envelope válido, inserir em `webhook_inbox` com `eventId` como chave idempotente.
5. Responder `202` imediatamente, sempre em menos de 5 segundos.
6. Processar de forma assíncrona depois da resposta.

`eventId` é estável nas reentregas e é a chave de deduplicação. O insert usa conflito condicional: só uma linha `FAILED` volta a `RECEIVED`, preservando contagem e envelope; `RECEIVED`, `PROCESSING`, `SUCCEEDED` e `DEAD` não são reabertos. `DEAD` significa falha permanente de processamento de envelope previamente válido, nunca requisição malformada. Evento já concluído recebe `202` sem novo efeito.

A Pluggy tenta até nove entregas: três consecutivas, mais três após 15 minutos e mais três após 2 horas. A aplicação deve assumir entrega “pelo menos uma vez”, fora de ordem e potencialmente repetida.

### Contrato por evento

| evento | ação assíncrona |
|---|---|
| `item/updated` | executar primeiro `GET /items/{itemId}`; persistir o estado atual e enfileirar coleta de contas/produtos se o estado permitir |
| `transactions/created` | confirmar `itemId`/`accountId`, seguir `createdTransactionsLinkV2`; em aplicações novas, `createdTransactionsLink` já pode apontar para `/v2`; validar host/path/conta, paginar por `next` e fazer upsert |
| `transactions/updated` | confirmar `itemId`/`accountId`, agrupar `transactionIds` em lotes de no máximo **400**, chamar `/v2/transactions?accountId=...&ids=...` e fazer upsert |
| `transactions/deleted` | confirmar `itemId`/`accountId`, agrupar os IDs em lotes de no máximo **1.000** e fazer upsert em `transaction_tombstones`, mesmo para ID desconhecido; materializar `deleted_at` quando a transação existir |

Se `accountId` ainda não existir localmente, o worker atualiza contas por `GET /accounts?itemId=...` antes de continuar. Se a conta continuar ausente ou pertencer a outro Item, nenhuma linha/tombstone é criada: o envelope válido vai a `DEAD` com código sanitizado `ACCOUNT_SCOPE_INVALID`, abre saúde operacional e a reconciliação permanece o fallback. Nunca se cria conta fantasma só para satisfazer FK.

O limite documentado de `ids` em `/v2/transactions` é 500; o lote de 400 deixa margem para URL e intermediários. O evento de delete não exige reler a API. Create/update atrasado, por si só, não limpa tombstone; somente uma leitura atual de `/v2/transactions` que devolva o ID é autoritativa para isso.

## 11. Tratamento de erros

| condição | comportamento |
|---|---|
| `400` | erro permanente de contrato; registrar endpoint e nomes dos parâmetros, sem payload; não repetir automaticamente |
| `401` | renovar a API key e repetir uma única vez |
| `403` | falha de escopo/credencial; encerrar ciclo e alertar |
| `404` | marcar referência para reconciliação; não remover dado local imediatamente |
| `410` | falha permanente que denuncia uso do endpoint legado; abrir alerta operacional |
| `429` | respeitar `Retry-After`; senão, backoff exponencial com jitter |
| `5xx`, timeout ou rede | retry exponencial limitado; preservar watermark e cursor de retomada |
| cursor inválido em incremental | descartar o cursor e reiniciar a fonte em `createdAtFrom = watermark confirmado - overlap` |
| cursor inválido em full | abortar o epoch incompleto, limpar cursor/run, criar novo `reconciliation_epoch` atomicamente e voltar à primeira página; ausência só é aplicada ao fim do novo epoch |

O parser não inclui corpo completo em exceções. Logs guardam `request_id` do provedor, endpoint sem query sensível, status, duração e tentativa; nunca headers, IDs financeiros em texto aberto ou payloads.

## 12. Consentimento e degradação

`consentExpiresAt` veio `null` no Item medido. A documentação oficial informa que `null` pode representar consentimento sem expiração, mas isso ainda precisa ser confirmado especificamente para o conector MeuPluggy usado pelo projeto.

Enquanto não houver uma fonte confiável para a data:

- a UI não inventa countdown de consentimento;
- o backend persiste `null` como “sem data informada”, não como garantia eterna;
- falha de sincronização, Item em erro, dados vazios inesperados e atraso além de `nextAutoSyncAt` geram aviso de reconexão;
- o sistema continua mostrando o último snapshot válido com indicador de desatualização;
- não se cria automaticamente outro Item e não se força atualização.

## 13. Referências oficiais consultadas

- [Autenticação](https://docs.pluggy.ai/reference/auth)
- [Contas](https://docs.pluggy.ai/docs/accounts)
- [Transações por cursor](https://docs.pluggy.ai/reference/transactions-list-by-cursor)
- [Conceitos de transação e webhooks](https://docs.pluggy.ai/docs/transactions)
- [Categorias](https://docs.pluggy.ai/docs/transaction-categories)
- [Faturas de cartão](https://docs.pluggy.ai/docs/credit-card-bills)
- [Webhooks](https://docs.pluggy.ai/docs/webhooks)
- [Consentimentos e expiração](https://docs.pluggy.ai/docs/consents)

## Pendências / a confirmar

- **Gate de segurança:** credenciais Pluggy foram expostas em canal de planejamento; rotacionar todas as credenciais afetadas antes de qualquer teste/implementação e gerar um Bearer novo para o webhook na implantação. Não reutilizar API key efêmera que tenha sido colada e não copiar qualquer valor para arquivo, log ou comando. *(Nota 24/08: a chave efêmera usada no teste desta rodada expira sozinha em ~2 h; o client secret de teste continua exposto em conversa — rotação antes da F1 segue obrigatória.)*
- Descobrir de onde obter a data de expiração do consentimento no conector MeuPluggy quando `consentExpiresAt` vier `null` e validar se `null` significa realmente não expirar neste tenant. *(Reconfirmado 24/08: `null` no Item real.)*
- ~~Confirmar ordem decrescente por `date`~~ **RESOLVIDO (24/08/2026): decrescente confirmada no tenant.** Desempate por `order` dentro da mesma data permanece como regra de normalização local.
- ~~Testar `dateFrom` e `dateTo`~~ **RESOLVIDO (24/08/2026): aceitos com HTTP 200**, filtro por `date`. Uso liberado como otimização de janela; regras de overlap/reconciliação não mudam.
- Estado do webhook medido (24/08/2026): **nenhum webhook configurado na aplicação** — o provisionamento de `https://pulso-hooks.cursar.space/api/webhooks/pluggy` (modalidade por aplicação) é pré-requisito duro da F1; sem ele, só o harvest agendado existe.
- Credenciais desta rodada apontam para um **Item sandbox/produção de teste** (conector MeuPluggy, `isSandbox: false`, saldos pequenos). Confirmar com o proprietário antes da F1 se este Item é o definitivo ou se a implementação usará outro.
- Na rodada de implementação, provisionar o endpoint já escolhido `https://pulso-hooks.cursar.space/api/webhooks/pluggy` somente na modalidade por aplicação, removendo/evitando `webhookUrl` simultâneo por Item.
