# PulsoFinanceiro — roadmap

## 1. Objetivo do roadmap

Este roadmap leva o PulsoFinanceiro de documentação a produto autônomo em produção, por fatias verticais verificáveis. Cada fase atravessa aquisição de dados, persistência, API interna, interface, observabilidade, segurança e testes quando esses elementos forem necessários ao resultado; não existem fases isoladas “só backend” ou “só frontend”.

Hermes é uma fase própria e posterior. O PulsoFinanceiro deve sincronizar, calcular, alertar na própria interface e operar com segurança sem depender da frota de agentes.

## 2. Regras de execução

1. A sequência das fases é obrigatória. Itens podem ser preparados antes, mas não são declarados entregues sem cumprir o gate da fase.
2. “Implementado” significa código e testes locais; “validado” exige execução com artefato real controlado; “publicado” exige serviço, borda, backup e smoke test no hostname. Os status não são sinônimos.
3. Nenhuma fase cria autenticação própria, tabela `users` ou tela de login.
4. O site nunca cria entrada manual de lançamento, meta, orçamento, recorrência ou importação; suas únicas mutações financeiras são os dois overrides canônicos. F8 contém uma única exceção posterior e externa ao site para clarificar transação pelo Hermes privado, com escopo/gate próprios.
5. Toda métrica nasce de endpoint da API interna antes de ganhar widget.
6. O tema é escuro e exclusivo desde a primeira tela; não existe débito de “aplicar design depois”.
7. Dados reais, segredo, identificador de integração e PII não entram em commit, fixture, screenshot público ou log.
8. Serviço web faz bind em `127.0.0.1:3040`. Os hostnames planejados são `pulso.cursar.space` (humano, protegido) e `pulso-hooks.cursar.space` (webhook estreito); publicação só ocorre após decisão e implantação da proteção de borda.
9. A rotina normal colhe dados que a Pluggy já atualizou. Não força update do item. Webhook pode antecipar o harvest, mas reconciliação agendada é obrigatória porque webhook pode se perder.
10. Banco, túnel, serviço, chave e configuração só podem ser alterados numa rodada com autorização operacional explícita.
11. As contagens reais observadas são telemetria e base para fixtures de escala, nunca gate rígido de número de contas, categorias, faturas ou transações; o gate valida completude pelo cursor/contrato e invariantes.

## 3. Visão das fases

| Fase | Resultado utilizável | Dependência | Estado inicial |
|---|---|---|---|
| F0 | plano executável e repositório sem dados | nenhuma | rodada de planejamento |
| F1 | sincronização confiável visível numa UI mínima | F0 aprovado | não iniciada |
| F2 | visão financeira determinística do mês | F1 validada | não iniciada |
| F3 | cartão e recorrências acionáveis | F2 validada | não iniciada |
| F4 | análises comportamentais, poupança e overrides | F3 validada | não iniciada |
| F5 | IA narrativa, barata e sanitizada | F4 validada | não iniciada |
| F6 | produto autônomo endurecido e publicado | F1–F5 conforme corte de release | não iniciada |
| F7 | integração de leitura e alertas com Hermes | F6 estável | posterior, não iniciada |
| F8 | clarificação privada de transação pelo Hermes | F7 estável + gate específico | posterior, não iniciada |

F5 pode ficar fora do primeiro release público sem bloquear F6. Nesse corte, o produto continua completo no núcleo determinístico; nenhuma métrica depende de IA.

## 4. F0 — planejamento, decisões e higiene do repositório

### Resultado

Documentação suficiente para outro agente implementar sem acesso à conversa original, com nomes, contratos, fórmulas, limites de segurança e gates coerentes.

### Entregáveis

- visão, arquitetura, infraestrutura, integração Pluggy, modelo de dados, job, API, design system, telas, IA, segurança, roadmap, ADRs e integração Hermes;
- nome `PulsoFinanceiro`, porta `3040` e hostnames `pulso.cursar.space`/`pulso-hooks.cursar.space` registrados de modo idêntico;
- repositório público contendo somente documentação e arquivos de configuração documental permitidos;
- varredura do conteúdo versionado para segredo, CPF, UUID/identificador real, conta, cartão, saldo, merchant e dump;
- opções de proteção humana documentadas, com Cloudflare Access recomendado e decisão final reservada ao proprietário.
- direção 3D/animada com referências internas, equivalentes originais, budgets/fallbacks e gate de licença documentados; nenhum asset é criado nesta rodada.

### Fora da fase

Código, instalação, banco, migração, serviço, tunnel, DNS, webhook e deploy.

### Gate de saída

- todos os documentos terminam em “Pendências / a confirmar”;
- não há contradição entre endpoint, tabela, env var, porta e domínio;
- exemplos são fictícios e nenhum dado medido sensível foi reproduzido;
- o proprietário aprova as decisões pendentes e autoriza explicitamente a próxima rodada.

## 5. F1 — fundação e sincronização observável

### Resultado

Uma fatia vertical Pluggy → SQLite → API → interface escura comprova que os dados são colhidos de forma idempotente e que o usuário sabe se estão atualizados.

### Pré-condições

- implementar primeiro o middleware de identidade do origin e prová-lo localmente com emissor/JWKS **fictícios**: JWT válido chega à `/api/v1`, ausente/inválido falha mesmo por loopback. Isso não cria Tunnel, DNS ou política real;
- cumprir `CRED-001` antes de qualquer chamada Pluggy real; sem rotação, F1 usa somente fixtures fictícias.

### Escopo ponta a ponta

**Dados e persistência**

- criar o SQLite no diretório de banco do projeto, habilitar WAL e `foreign_keys` em toda conexão;
- aplicar schema de item, contas, snapshots, categorias, transações, faturas, execuções de sync, overrides e outbox;
- armazenar JSON bruto sanitizado e impedir persistência de CPF em `paymentData.payer.documentNumber`;
- implementar upsert por `transaction.id`, inclusive mudança `PENDING → POSTED` e alteração de valor;
- sincronizar categorias e usar `descriptionTranslated`; classificar prefixo `04` como transferência interna.

**Integração e job**

- cumprir `CRED-001` antes da primeira chamada: rotacionar o Client Secret exposto no Dashboard Pluggy, descartar a API key efêmera colada e configurar valores novos somente no arquivo privado; nenhum valor/fragmento entra em comando, Git, vault ou log;
- autenticar no backend, manter token somente em memória e renovar antes da expiração;
- executar carga inicial de 12 meses por cursor de `/v2/transactions`, sem usar parâmetros rejeitados nem o endpoint legado;
- executar incremento diário por `createdAtFrom` desde o último sucesso, com watermark seguro e sobreposição controlada;
- implementar full resync de reconciliação por cursor, semanal ou sob demanda, condicionado à confirmação da ordem decrescente por `date` antes de usar parada antecipada;
- implementar inbox/handler e testar com fixtures locais Bearer, deduplicação, resposta em menos de 5 segundos e fallback agendado. **Não** registrar webhook real nesta fase; a configuração remota depende do host protegido de F6. A Pluggy não documenta HMAC, portanto nenhuma assinatura é presumida;
- colher `items`, contas, categorias, faturas, investimentos e empréstimos sem forçar update do item;
- registrar retry com backoff, cursor, contagens, falha e último sucesso.

**API e interface**

- disponibilizar `GET /api/v1/system/health` e `GET /api/v1/transactions` com dados sanitizados;
- entregar AppShell escuro, widget de saúde e drawer de transações de auditoria;
- exibir último sync, próximo `nextAutoSyncAt`, estado do item, alterações do ciclo e quantidade `PENDING`;
- degradar investimentos, empréstimos e consentimento nulo para estados vazios/indisponíveis, sem quebrar a tela.

**Operação**

- produzir logs estruturados sem segredo ou PII;
- criar rotina de backup consistente do SQLite e ensaiar restauração em arquivo separado;
- usar fixtures integralmente fictícias nos testes e manter banco real fora do repositório.

### Gate de saída

- a carga inicial percorre todas as páginas esperadas e um segundo ciclo não duplica linha;
- evidência sem valores confirma Client Secret rotacionado e configuração privada; a API key colada nunca é reutilizada;
- fixture e teste controlado demonstram atualização no lugar de `PENDING` para `POSTED`;
- watermark só avança após commit completo; falha intermediária é retomável;
- JSON persistido não contém CPF do pagador e payload público não contém titular, conta ou cartão;
- fixture de webhook duplicado dispara no máximo um harvest lógico e a reconciliação encontra alteração simuladamente perdida; nenhuma configuração Pluggy/DNS é alegada em F1;
- backup restaurado abre, passa `integrity_check` e preserva contagens/chaves;
- o widget de saúde corresponde ao banco e mantém último dado válido em caso de falha.

## 6. F2 — núcleo financeiro determinístico

### Resultado

O usuário abre a Visão geral e entende patrimônio observável, ritmo, projeção, concentração temporal e gasto por categoria sem consultar extrato manualmente.

### Escopo ponta a ponta

- capturar snapshots de conta necessários à série, sem inventar histórico anterior;
- implementar regra consolidada que exclui transferências internas e os dois lados (`BANK_DEBIT`/`CARD_CREDIT`) de pagamentos de cartão ligados por `transaction_bill_payment_matches`; crédito de cartão sem match fica ajuste não classificado com qualidade parcial, sem rótulo de estorno;
- disponibilizar `GET /api/v1/dashboard/overview`, `GET /api/v1/analytics/monthly-pace` e `GET /api/v1/analytics/categories`;
- entregar patrimônio consolidado, termômetro, projeção, dia mais caro, heatmap, rollup de categoria e comparação mensal;
- aplicar a Sentinela de Camadas e o Condutor do Pulso como progressão visual 2D funcional; 3D permanece lazy e só entra quando o fallback já cumprir o contrato;
- devolver `computedAt`, `dataThrough`, `period`, `metricVersion`, `quality`, moeda, contagens e composição em todos os contratos de métrica; `metricId` identifica apenas valores métricos citáveis, não eventos;
- abrir evidências pelo `GET /api/v1/transactions` sem recalcular valor no navegador;
- criar eventos de outbox para limite/ritmo/anomalia somente quando a regra determinística já estiver testada, ainda sem entrega por canal.

### Gate de saída

- soma de composições fecha com cada card em fixtures de mês completo, parcial, com crédito de cartão classificado/não classificado e com `PENDING`;
- prefixo `04`, overrides futuros e pagamento de fatura não inflam gasto;
- mês parcial compara os mesmos dias e base zero não gera infinito;
- patrimônio mostra lacuna antes do primeiro snapshot, não série reconstruída;
- estados de moeda incompatível, histórico insuficiente, stale e erro parcial têm teste de contrato e teste visual;
- browser em 360, 768 e 1440 px exibe os mesmos números da API.
- desligar WebGL ou reduzir movimento mantém 100% da leitura e das ações, sem regressão de contraste/foco.

## 7. F3 — cartão e recorrências

### Resultado

O usuário enxerga risco de limite, ciclo e custo do cartão, além de cobranças repetidas que merecem atenção.

### Escopo ponta a ponta

**Cartão**

- disponibilizar `GET /api/v1/credit-card` e `GET /api/v1/bills`;
- entregar medidor de limite com faixas normal, atenção, alta e crítica;
- agrupar fatura em formação por `billForecastDate`, separando `POSTED` e `PENDING`;
- exibir todas as faturas disponíveis no período consultado com fechamento, vencimento, total, mínimo e encargos; a fixture observada de 12 faturas é evidência, não cardinalidade fixa;
- calcular contador anual de encargos com componentes e ressalva de possível sobreposição até validação;
- entregar countdown sem alegar inadimplência quando a fonte não informa pagamento.

**Recorrências**

- disponibilizar `GET /api/v1/analytics/recurrences`;
- detectar cadência e estabilidade por CNPJ ou descrição normalizada;
- detectar reajuste estatisticamente sustentado;
- manter estados de recorrência `ACTIVE`, `DORMANT` e `RESUMED`, persistindo `last_gap_days`/`resumed_at` quando uma cobrança volta após hiato coberto;
- calcular custo anualizado por cadência;
- descartar explicitamente qualquer inferência de “assinatura sem uso”, pois não existe dado de utilização.

**Alertas persistidos**

- produzir outbox para `CREDIT_LIMIT_BAND_CHANGED`, `BILL_DUE_SOON`, `RECURRENCE_PRICE_INCREASE` e `RECURRENCE_RESUMED_AFTER_GAP`;
- usar chave de deduplicação ativa que inclua tipo, entidade, janela/ciclo e versão; fechar o episódio com `condition_closed_at` na recuperação para permitir reincidência futura; não enviar a canal nesta fase.

### Gate de saída

- percentuais nas fronteiras de 70%, 85% e 95% retornam a faixa correta;
- fatura confirmada/provisória fecha com as transações do ciclo e não expõe número do cartão;
- histórico preserva lacunas e não estima fatura ausente;
- recorrência exige amostra mínima e cada alerta abre evidências;
- nenhuma cópia afirma uso, cancelamento, fraude ou inadimplência sem dado que sustente;
- repetir o cálculo no mesmo ciclo não duplica evento de outbox.

## 8. F4 — análises comportamentais, poupança e correções dirigidas

### Resultado

O painel explica onde e com quem o dinheiro saiu, destaca exceções e permite as duas correções estritamente autorizadas.

### Escopo ponta a ponta

- disponibilizar `GET /api/v1/analytics/merchants`, `GET /api/v1/analytics/pix`, `GET /api/v1/analytics/anomalies` e `GET /api/v1/analytics/savings`;
- entregar ranking por CNPJ com fallback de descrição separado;
- entregar possíveis duplicidades com janela inferior a 24 horas e IDs distintos;
- entregar o detector `LOG_ZSCORE` dentro de categoria com amostra mínima; não chamá-lo de z-score robusto;
- entregar PIX recebido/enviado por contraparte, sem usar CPF/documento;
- entregar evolução da poupança e `variação_residual = variação_saldo − aportes_internos + retiradas_internas`; usar “rendimento estimado” somente após confirmar a semântica da fonte, além de referência automática de 6 meses e streak documentado;
- disponibilizar `PUT /api/v1/transactions/:id/category-override` com taxonomia existente, `ruleScope = MERCHANT_CNPJ|DESCRIPTION_RAW_NORMALIZED` e `If-Match` obrigatório;
- disponibilizar `PUT /api/v1/transactions/:id/internal-transfer-override` com `If-Match` e estado `true|false|null`, em que `null` remove o override;
- recalcular métricas e eventos afetados após override, mantendo categoria/decisão original para auditoria.
- habilitar o Catalisador da Virada somente para marcos determinísticos de economia/streak, deduplicado por métrica + limiar e sem mecânica de aposta/loot box.

### Gate de saída

- toda possível duplicidade tem dois IDs e não confunde upsert de status;
- z-score não executa com menos de 20 ocorrências ou desvio zero;
- soma de PIX por contraparte fecha com entrada/saída elegível e transferências próprias ficam separadas;
- aporte/retirada interna é removido da variação residual; sem confirmação semântica, `estimatedYield` permanece `null` mesmo com cobertura completa;
- meta deriva do histórico e não oferece campo de criação/edição;
- apenas as duas rotas de mutação aparecem no tráfego do frontend;
- override repetido é idempotente e atualiza todas as métricas dependentes no backend.

## 9. F5 — camada de IA opcional e controlada

### Resultado

IA comenta e explica métricas do PulsoFinanceiro sem recalcular números, sem enviar extrato em massa e sem expor PII.

### Escopo ponta a ponta

- implementar sanitização obrigatória antes da montagem de qualquer prompt;
- montar contexto com agregados identificados, amostras dirigidas e janela mínima;
- entregar somente ações allowlisted por controles de um clique no site: narrativa mensal, explicação de anomalia, nome de recorrência, sugestão para categoria não classificada e comentário de projeção;
- usar modelo principal de baixo custo e fallback documentado, com teto de tokens, timeout e custo estimado por chamada;
- exigir citação de `metricId`/origem para toda afirmação numérica;
- marcar visualmente conteúdo de IA, permitir falha isolada e manter todo painel determinístico disponível;
- registrar telemetria de custo e latência sem prompt cru que contenha dado sensível.
- manter a ação de IA sem persistência financeira; consulta textual livre pertence exclusivamente ao chat Hermes em F7/H3.

### Gate de saída

- teste de sanitização bloqueia CPF, titular, número de conta, número de cartão, `itemId`, `accountId` e segredo;
- conjunto de evals detecta número não presente nas métricas fornecidas;
- nenhuma requisição envia transações cruas em massa;
- fallback e indisponibilidade do provedor não afetam widgets determinísticos;
- custo máximo por caso e por mês está visível na operação antes de habilitar a feature.
- ações de IA não escrevem estado financeiro; consulta livre continua fora do site.

## 10. F6 — endurecimento e publicação do produto autônomo

### Resultado

PulsoFinanceiro funciona continuamente, restaurável e observável, sem Hermes, pela decisão A em `pulso.cursar.space`; se A tiver impedimento documentado e nova aprovação, o fallback B opera sem hostname público. Exposição aberta não é caminho de release.

### Pré-condições

- autorização operacional de A, Cloudflare Access com um único e-mail, ou decisão excepcional por B, Tailscale sem hostname público e com proxy autenticador externo; o PulsoFinanceiro não cria token/sessão humana;
- autorização para criar/alterar unit, tunnel, DNS, arquivo de ambiente do projeto, banco e rotina de backup;
- confirmação de que a porta `3040` e, somente no caminho A, os hostnames propostos permanecem livres no momento do deploy.
- gate visual concluído: licença/autorização aplicável para uso reconhecível de *Jujutsu Kaisen* ou substituição integral pelos mascotes originais e distintos; ausência de decisão bloqueia asset oficial, não o produto.

### Escopo ponta a ponta

- executar build reproduzível e iniciar serviço com usuário sem privilégio, bind exclusivo em `127.0.0.1:3040` e restart controlado;
- executar somente o ramo aprovado: **A**, Tunnel + `Protect with Access` **e** JWT revalidado no origin; ou **B**, sem DNS/hostname público e com asserção assinada por proxy autenticador Tailscale externo;
- no caminho A, registrar por `POST /webhooks` um webhook no nível da aplicação apontando ao host dedicado, sem combinar `webhookUrl` no Item, e provar Bearer/WAF/dedup/fallback; no B, não registrar webhook e operar por incremental + reconciliação;
- aplicar rate limit, cabeçalhos, limites de payload, timeouts e proteção do webhook;
- configurar segredo somente fora do repositório e permissões mínimas de arquivo;
- agendar sync incremental, full resync e backup, com lock contra execução concorrente;
- testar restauração em localização isolada e documentar RPO/RTO observados;
- executar varredura de segredo/PII, teste de contrato, integração Pluggy controlada, e2e, teste visual e smoke externo;
- medir budgets do design system: bundle crítico, chunk 3D lazy, texturas/triângulos/draw calls, LCP/INP/CLS e frame time; falha força fallback 2D;
- testar `prefers-reduced-motion`, `Save-Data`, WebGL ausente, perda de contexto, aba oculta e dispositivo móvel intermediário;
- validar estados stale/falha sem derrubar a leitura do último snapshot;
- preparar rollback do binário/configuração e compatibilidade de schema antes de cada release.

### Gate de saída

- no ramo A, hostname exige Access na borda e JWT no origin, inclusive contra chamada direta; no B, nenhum hostname público é criado e o proxy autenticador é testado; não existe ramo C;
- requisição que chega pelo loopback continua sujeita à identidade do ramo escolhido, Bearer do webhook ou token/escopo de serviço conforme a rota;
- processo reinicia após falha controlada, mas não entra em loop agressivo;
- sync, API, UI, backup e restauração foram executados no ambiente real;
- smoke externo verifica overview, cartão, análises, poupança e health;
- versão implantada, commit, data, migração e resultado dos gates ficam registrados;
- nenhum serviço do Hermes participa da disponibilidade do PulsoFinanceiro.
- a release contém somente assets com proveniência/licença aprovadas e nenhuma likeness/nome oficial sem autorização.

## 11. F7 — integração posterior com Hermes

### Resultado

Hermes lê agregados compactos, consome eventos persistidos e envia avisos por canais já administrados pela frota, sem ganhar poder de alterar finanças.

### Condição de entrada

F6 deve permanecer estável por uma janela operacional acordada, com sync, backup, contratos versionados e outbox observados. A integração não será usada para mascarar lacuna do produto autônomo.

### Escopo ponta a ponta

**Identidade de máquina**

- cadastrar cada corpo/perfil como principal distinto em `service_principals`, entregar seu token bruto uma vez fora do repositório e manter somente hashes `current`/`next`, escopos e metadados de rotação/revogação no PulsoFinanceiro;
- conceder somente `metrics:read`, `events:read`, `events:claim` e `events:ack` conforme a necessidade; claim/ack são escritas operacionais, nunca financeiras;
- documentar rotação, revogação e auditoria independentes da sessão humana na borda.

**Contratos compactos**

- expor JSON versionado e agregado para fechamento, projeção, cartão, recorrências, anomalias e saúde, com `computedAt`, `dataThrough`, `period`, `metricVersion`, `quality`, moeda e contagens;
- manter equivalência: número entregue ao Hermes é o mesmo número da rota usada pelo frontend;
- limitar período, itens e tamanho para respeitar orçamento de tokens; nunca oferecer dump bruto por conveniência.

**Outbox e alertas**

- manter `GET /events` como snapshot read-only e realizar lease apenas por `POST /events/claim`; ack exige `leaseToken`, `deliveryId` e outcome terminal `DELIVERED` ou `DISMISSED` com razão allowlisted;
- cobrir limite por faixa, vencimento, sync defasado, ritmo fora do padrão, reajuste, retomada após hiato, possível duplicidade e lançamento atípico;
- permitir que `UNKNOWN_TRANSACTION_NEEDS_CONTEXT` apareça somente como evento read-only/observabilidade; F7 não pergunta nem aceita resposta;
- manter canal e redação fora do PulsoFinanceiro. Discord/WhatsApp são escolhas do Hermes;
- deduplicar por tipo + entidade + ciclo/janela + versão enquanto `condition_closed_at IS NULL`; recuperação fecha o episódio e uma reincidência cria outro.

**Casos de uso Hermes**

- consulta em linguagem natural pelo chat com os agregados autorizados, primeira vez em F7/H3;
- avisos proativos;
- planejamento financeiro baseado no fechamento/projeção;
- rascunho de fechamento mensal pelo protocolo do vault, executado pelo Hermes e nunca pelo backend financeiro; qualquer escrita depende antes de um destino cuja privacidade para dados financeiros tenha sido formalmente aprovada ou de formato explicitamente não sensível.

**Limites**

- primeira integração é somente leitura financeira; claim/ack são operações de fila, e `clarifications:read_private`/`clarifications:write` não são concedidos em F7;
- escrita futura exige endpoint, escopo e ADR separados;
- backend do PulsoFinanceiro não conhece canal;
- handoff entre agentes usa Kanban, nunca bot falando diretamente com bot.

### Gate de saída

- revogar o token interrompe Hermes sem afetar acesso humano nem o app;
- token sem escopo recebe negação; tentativa de escrita recebe negação;
- payload agregado permanece abaixo do teto documentado e não contém PII;
- evento entregue e confirmado não reaparece; falha volta por retry sem duplicar indefinidamente;
- o mesmo indicador exibido no site e citado pelo Hermes tem `metricId`, período, moeda e valor idênticos;
- indisponibilidade do Hermes acumula eventos com limite/retention definidos e não bloqueia sync nem API.

## 12. F8 — clarificação privada de transação pelo Hermes

### Resultado

Quando uma transação não possui descrição, merchant, alias ou sinais suficientes para uma classificação confiável, o Hermes pode pedir contexto em canal privado e salvar uma resposta auditável para a ocorrência e repetições, sem criar formulário no site.

### Condição de entrada

- F7 estável e primeira integração validada sem escrita financeira;
- principal/perfil e canal privado aprovados, com retenção definida;
- ameaça/abuso, auditoria, rollback de regra e testes de PII aprovados;
- concessão explícita e isolada de `clarifications:read_private` e `clarifications:write` ao principal financeiro; nenhum implica o outro.

### Escopo ponta a ponta

- reutilizar a clarificação/evento read-only aberto por detector versionado quando sinais normalizados não atingem limiar fechado; ausência momentânea de sync não gera pergunta;
- payload do evento usa `clarificationId`, versão, transaction ID local, direção, data civil, faixa de valor e sugestões fechadas; não inclui descrição/merchant bruto, valor exato, PII, ID Pluggy ou canal;
- Hermes escolhe Discord privado allowlisted e, somente então, busca data/valor/moeda mínimos por `GET /api/agent/v1/clarifications/:id` com `clarifications:read_private`, resposta `no-store` e descarte imediato; PulsoFinanceiro permanece sem SDK/nome de canal;
- apresentar sugestões/botões, resposta curta opcional e escolha explícita “aplicar a semelhantes”; resolver por `POST /api/agent/v1/clarifications/:id/resolve` com `If-Match`, `Idempotency-Key`, `applyToSimilar` e `clarifications:write`;
- aceitar somente `ACCEPT_CATEGORY_SUGGESTION` por `suggestionRef` existente ou `SET_NORMALIZED_ALIAS` com alias NFKC de 1–60 caracteres após denylist;
- persistir principal, `transaction_revision_key`, outcome interno `CATEGORY_ONLY|CATEGORY_OVERRIDE|NORMALIZED_ALIAS`, `apply_to_similar`, regra criada/não criada e timestamps; reaplicar primeiro por CNPJ/descrição e, na ausência deles, somente por `transaction_context_rules` com `SOURCE_FINGERPRINT_V1/HIGH`, mesma conta/direção/moeda/faixa de valor e matcher determinístico;
- na primeira aplicação de uma context rule, persistir a application e emitir revisão privada “apliquei sua regra; corrigir?”; uma decisão divergente desativa a regra antiga e corrige a transação atomicamente, enquanto silêncio mantém o resultado sem repetir a pergunta original;
- atualização da transação durante a pergunta invalida a versão antiga; resposta stale não sobrescreve a fonte;
- mensagem Discord/resposta crua não entra no banco, log, IA ou payload de evento.

### Limites

- exceção não autoriza valor/data, lançamento, orçamento, meta, importação, query SQL ou texto livre como categoria;
- site permanece zero-input e não expõe a rota;
- primeira integração Hermes permanece sem esses escopos;
- falha/silêncio expira a clarificação sem alterar classificação; não faz retry invasivo infinito.

### Gate de saída

- canal coletivo e principal sem o escopo exato da rota recebem negação; `clarifications:write` não permite ler valor, e `clarifications:read_private` não permite resolver;
- PII/segredo/controle de caracteres e alias fora da allowlist são bloqueados;
- `If-Match` stale e idempotency key repetida preservam estado correto;
- aceitar sugestão ou alias produz auditoria; `applyToSimilar: true` só cria regra reproduzível quando CNPJ/descrição segura ou `SOURCE_FINGERPRINT_V1/HIGH` estiver oferecida, baixa confiança retorna `SIMILAR_RULE_NOT_SAFE`, a revisão da primeira reaplicação torna a correção executável e expirar não muda transação;
- backend não contém nome/ID de Discord e handoff entre corpos continua por Kanban.

## 13. Backlog posterior, sem compromisso de implementação

- investimentos e empréstimos ganham widgets somente quando a Pluggy retornar dados reais suficientes;
- suporte multi-moeda depende de fonte de câmbio auditável;
- escrita financeira pelo Hermes ou por IA depende de threat model, escopo separado e autorização explícita;
- ajuste manual de referência/meta permanece fora até existir evidência de que uma escolha sugerida é necessária e compatível com “zero entrada manual”;
- aplicativo nativo só será avaliado se a web responsiva não atender o uso móvel.

## 14. Definition of Done para qualquer fase

Uma fase só termina quando:

- contrato, schema, regra e UI usam os mesmos nomes;
- testes unitários de fórmula, contrato, integração e regressão cobrem fronteiras e falhas relevantes;
- teste e2e prova o fluxo completo com fixtures fictícias;
- quando há UI, render em 360, 768 e 1440 px foi inspecionado, incluindo empty, stale e erro;
- quando há integração real, resultado foi validado em runtime e não inferido de build verde;
- logs e artefatos foram varridos para segredo/PII;
- backup/rollback aplicáveis foram exercitados;
- documentação e pendências foram atualizadas;
- o handoff distingue implementado, validado localmente, validado com dado real, publicado e ainda pendente.

## Pendências / a confirmar

- Autorizar operacionalmente Cloudflare Access antes da F6 e informar o e-mail apenas na configuração privada; se A for inviável, uma nova decisão pode aprovar o fallback Tailscale. Exposição aberta foi descartada.
- Confirmar a ordem decrescente garantida por `date` em `/v2/transactions` antes de habilitar parada antecipada no full resync.
- Revalidar no deploy os headers customizados, o IP de saída publicado e o retry oficial do webhook; não inventar assinatura HMAC.
- Definir a janela mínima de estabilidade operacional da F6 antes de iniciar a F7 com Hermes.
- Escolher licença de personagens ou mascotes originais antes da F6; sem licença, nomes/likeness/assets oficiais ficam fora da release.
- Manter F8 bloqueada até aprovar `clarifications:read_private`, `clarifications:write`, canal privado, retenção e rollback de regras.
- Bloquear toda chamada Pluggy de F1 até concluir `CRED-001`; a rotação não faz parte desta rodada documental.
