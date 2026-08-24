# PulsoFinanceiro — telas e features

## 1. Regra de implementação

O frontend do PulsoFinanceiro é uma projeção visual da API interna. Ele não soma transações, não classifica recorrências, não calcula variação, não escolhe faixa de alerta e não reconstrói série temporal. Formatação de moeda, porcentagem e data é permitida; regra de domínio no componente é proibida.

Contratos canônicos de leitura:

- `GET /api/v1/dashboard/overview`;
- `GET /api/v1/analytics/monthly-pace`;
- `GET /api/v1/analytics/categories`;
- `GET /api/v1/analytics/merchants`;
- `GET /api/v1/analytics/pix`;
- `GET /api/v1/analytics/recurrences`;
- `GET /api/v1/analytics/anomalies`;
- `GET /api/v1/analytics/savings`;
- `GET /api/v1/credit-card`;
- `GET /api/v1/transactions`;
- `GET /api/v1/bills`;
- `GET /api/v1/system/health`.

Únicas mutações financeiras:

- `PUT /api/v1/transactions/:id/category-override`;
- `PUT /api/v1/transactions/:id/internal-transfer-override`.

Qualquer novo widget deve primeiro ganhar métrica e contrato na API. Um pull request que implementa cálculo financeiro somente no frontend deve ser rejeitado.

## 2. Convenções de cálculo

### 2.1 Valor canônico

Para uma transação `t`, `valor(t)` é o módulo de `amountInAccountCurrency` quando presente e na moeda da conta; caso contrário, usa o módulo de `amount`. Transações em moedas diferentes não são somadas sem conversão rastreável. O contrato devolve `currencyCode` e um estado `not_comparable` quando precisar separar moedas.

### 2.2 Saída, entrada e gasto

- `saída(t) = valor(t)` quando `type = DEBIT`.
- `entrada(t) = valor(t)` quando `type = CREDIT`.
- `gasto confirmado` soma somente saídas `POSTED` elegíveis e exclui `is_internal_transfer`.
- Um pagamento de fatura só é reconhecido pelo vínculo auditável em `transaction_bill_payment_matches`: o débito da conta (`role = BANK_DEBIT`) e o crédito do cartão (`role = CARD_CREDIT`) pareados ao mesmo `bill_payment_id` são ambos excluídos das métricas de gasto, recorrência e contraparte.
- Um `CREDIT` no cartão sem esse pareamento fica no componente separado `card_credit_unclassified`: não reduz gasto confirmado, não recebe rótulo de estorno e rebaixa para `quality = partial` qualquer interpretação que dependa de sua causa.
- `PENDING` nunca entra em realizado. Quando útil, aparece como camada provisória separada.

### 2.3 Recorte temporal

- Dia, mês, vencimento e comparação usam `America/Sao_Paulo`.
- “Mês atual” vai do primeiro dia local até o instante da consulta.
- Comparação de mês incompleto usa os mesmos dias decorridos do mês comparado; não compara um mês parcial com outro completo.
- Janelas de 3, 6 e 12 meses contam meses civis completos, salvo quando o contrato declarar “até hoje”.

### 2.4 Qualidade e explicabilidade

Cada resposta de métrica deve incluir `computedAt`, `dataThrough`, `period`, `metricVersion`, `quality`, `currencyCode` e as contagens mínimas de amostra/cobertura. `quality` admite `complete`, `partial`, `insufficient`, `stale`, `not_comparable` e `unavailable`. Cada valor citável recebe `metricId`; eventos usam `eventId` e não precisam de `metricId`. Todo card tem ação “Ver composição”, que consulta dados prontos da API ou abre `GET /api/v1/transactions` com filtros gerados pelo próprio widget.

Zero é um valor; ausência é um estado. O frontend não converte `null`, erro ou histórico insuficiente em zero.

## 3. Arquitetura de navegação

### 3.1 Destinos principais

1. **Visão geral:** patrimônio, termômetro, projeção, calendário de gastos e saúde do sistema.
2. **Cartão:** limite, fatura em formação, vencimento, histórico e encargos.
3. **Recorrências:** recorrentes detectadas, reajustes, retomadas após hiato e custo anualizado.
4. **Análises:** categorias, estabelecimentos, duplicidades, anomalias e PIX.
5. **Poupança:** saldo, variação residual, meta derivada e streak.

No mobile, esses destinos formam a navegação inferior. “Transações” não é destino principal: aparece em drawer de evidências ou página secundária acionada por um indicador.

### 3.2 Filtros

Filtros são escolhas fechadas vindas do contrato: período, conta, categoria, status e direção. Não há campo para criar lançamento, meta, recorrência ou orçamento. Busca no detalhamento de transações é somente leitura e não persiste dado novo.

### 3.3 Linguagem cinética e 3D

- **Sentinela de Camadas** — arquétipo interno inspirado na leitura/proteção de Gojo, Six Eyes e Infinity: anéis 2D/3D mostram saldo bancário, obrigação do cartão, provisório e margem como camadas reais do contrato.
- **Condutor do Pulso** — arquétipo interno inspirado nos raios de Kashimo: um pulso curto percorre fluxo, sync, streak e `LOG_ZSCORE` somente quando chega dado ou ocorre transição.
- **Catalisador da Virada** — arquétipo interno inspirado no jackpot de Hakari: celebração determinística quando economia/streak cruza um marco calculado, sem sorte, aposta, loot box, replay ou prêmio.

WebGL é lazy e opcional. Fallback 2D entrega a mesma hierarquia, texto, composição e ação; `prefers-reduced-motion`, `Save-Data`, hardware limitado ou falha de contexto o selecionam automaticamente. Satoru Gojo, Hajime Kashimo, Kinji Hakari e *Jujutsu Kaisen* são referências internas: nomes, likeness e assets não entram na UI pública sem autorização/licença; por padrão, a release usa os três mascotes originais e distintos definidos em `08-design-system.md`.

## 4. Tela Visão geral

### 4.1 Patrimônio consolidado

**Fórmula.** Para cada conjunto diário de snapshots `s`, `patrimônio_observável(s) = soma(closing_balance_minor das contas BANK) − open_bill_amount_minor do snapshot CREDIT`. A obrigação aberta, sua moeda, vencimento, fonte e qualidade são copiadas no mesmo `balance_snapshots` (`open_bill_*`) no instante da fotografia. A série histórica nunca faz join com a fatura mutável de hoje nem reconstitui uma obrigação passada retroativamente. `variação = patrimônio_fim − patrimônio_início`; a porcentagem só existe quando o módulo da base é maior que zero.

**Campos de origem.** Snapshot bancário: `closing_balance_minor`, `automatically_invested_balance_minor`, `captured_at`. Snapshot de crédito: `open_bill_amount_minor`, `open_bill_due_date`, `open_bill_currency_code`, `open_bill_source` (`BILLS`, `TRANSACTIONS_FALLBACK` ou `UNAVAILABLE`) e `open_bill_quality` (`COMPLETE`, `PARTIAL` ou `UNAVAILABLE`).

**Contrato e widget.** `GET /api/v1/dashboard/overview`. Card principal com valor, delta absoluto e percentual, seletor fechado de período e linha temporal. `LayerSentinel`/Sentinela de Camadas pode representar os componentes persistidos em anéis; cada anel abre a mesma composição, e o fallback 2D é o card. Realizado é sólido; qualidade parcial é tracejada.

**Exclusões e limitações.** `automaticallyInvestedBalance` não é somado enquanto não estiver confirmado se já compõe `closingBalance`. A série começa no primeiro snapshot local confiável; não se fabrica histórico de saldo retrocedendo transações. Snapshot de obrigação ausente ou em moeda incompatível retorna `quality = partial`/`not_comparable`, não zero. Investimentos fora das três contas observadas não entram e o rótulo deve ser “patrimônio observável”, não “patrimônio total”.

**Critérios de aceite.** Com fixture de dois saldos bancários e uma obrigação persistida, o valor devolvido pela API satisfaz a fórmula; atualizar a fatura atual não altera snapshots históricos; novo snapshot conserva valor, fonte e qualidade da obrigação daquele instante; período sem snapshot inicial retorna `quality = insufficient`; o browser apresenta exatamente o valor e a série da API.

### 4.2 Termômetro do mês

**Fórmula.** No dia local `d`, `ritmo = gasto_confirmado_do_dia_1_ao_d / média(gasto_confirmado_dos_dias_1_ao_d nos 6 meses anteriores)`. O delta é a diferença absoluta e percentual contra essa média. A API também devolve a média mínima e máxima do histórico para contextualizar a faixa.

**Campos de origem.** Transação: `date`, `status`, `type`, `amountInAccountCurrency`, `accountId`, `categoryId`, `creditCardMetadata.billForecastDate`; classificações locais de transferência interna, matches de pagamento de fatura e crédito de cartão não classificado.

**Contrato e widget.** `GET /api/v1/analytics/monthly-pace`. Termômetro horizontal com marca de 100%, realizado, delta e texto “X% acima/abaixo do seu padrão até este dia”. `PulseConduit`/Condutor do Pulso desenha uma descarga única até a faixa devolvida pela API quando a razão muda; não fica em loop nem substitui o texto. `PENDING` aparece como extensão hachurada, sem alterar a razão confirmada.

**Exclusões e limitações.** Exclui transferências internas e as duas transações de cada pagamento de fatura pareado. Exige ao menos 3 meses comparáveis; com 3 a 5 usa os disponíveis e informa a amostra. Se a média histórica usada como denominador for menor ou igual a zero, `ritmo` e percentual ficam `null` com `quality = insufficient` ou `not_comparable`; nunca há divisão, infinito ou 0% inventado. Mudança grande no calendário de renda não é causalidade e não deve ser explicada automaticamente como descontrole.

**Critérios de aceite.** Mês parcial é comparado aos mesmos números de dias; transações depois do dia equivalente não entram na base; `PENDING` não altera o valor confirmado; com menos de 3 meses o widget mostra “histórico insuficiente”, sem 0% fictício.

### 4.3 Projeção de fechamento

**Fórmula.** `projeção = gasto_confirmado_até_hoje + pendências_elegíveis + ritmo_não_recorrente × dias_restantes + recorrentes_previstas_ainda_não_cobradas`. `ritmo_não_recorrente = gasto_confirmado_não_recorrente / dias_decorridos`. `pendências_elegíveis` inclui saídas provisórias já observadas; crédito de cartão permanece componente separado até possuir semântica ou pareamento confirmado. Uma pendência que corresponde a recorrência esperada remove essa recorrência da parcela “ainda não cobrada”.

**Campos de origem.** `date`, `status`, `type`, `amountInAccountCurrency`, `accountId`, chave da recorrência, cadência, dia esperado e última ocorrência; calendário do mês local.

**Contrato e widget.** `GET /api/v1/analytics/monthly-pace`. Card com valor projetado, intervalo entre confirmado e projetado, barra de composição e linha até o último dia do mês. A composição nomeia realizado, provisório, ritmo e recorrências esperadas.

**Exclusões e limitações.** Exclui transferências internas, pagamento da fatura e recorrências já representadas por `PENDING`. Não prevê compras extraordinárias, renda futura nem mudança comportamental. Com menos de 14 dias úteis de histórico no mês ou sem recorrências confiáveis, a API reduz a confiança e explica qual parcela foi omitida.

**Critérios de aceite.** Uma recorrência já lançada não aparece de novo como futura; converter `PENDING` em `POSTED` preserva a projeção salvo mudança de valor; no último dia do mês a parcela de ritmo futuro é zero; o tooltip lista cada componente fornecido pela API.

### 4.4 Dia mais caro e mapa de calor

**Fórmula.** `gasto_dia = soma do gasto confirmado por date local`. O dia mais caro é o maior `gasto_dia`, com `order` usado para ordenar evidências no mesmo dia. Para cada dia da semana, `média_dow = soma dos gastos nos dias daquele DOW / quantidade de ocorrências daquele DOW no período`; o mapa também recebe o valor de cada data para não esconder concentração pontual.

**Campos de origem.** `date`, `order`, `status`, `type`, `amountInAccountCurrency`, `categoryId`, flags locais de exclusão.

**Contrato e widget.** `GET /api/v1/dashboard/overview`. Card do dia mais caro e heatmap em grade de semanas, com resumo das médias por segunda a domingo. Clique abre as transações que compõem a célula.

**Exclusões e limitações.** Exclui transferências internas, liquidação de fatura e provisórios. Empate usa data mais recente no destaque e conserva todos os empatados na composição. Um dia sem transação é zero somente se a cobertura de sincronização desse dia estiver completa; caso contrário, é lacuna.

**Critérios de aceite.** Soma das células do período coincide com o gasto confirmado do contrato; timezone na virada do dia é São Paulo; empate segue a regra; dia com sync incompleto não é pintado como zero.

## 5. Tela Cartão

### 5.1 Uso do limite

**Fórmula.** `limite_usado = creditLimit − availableCreditLimit`; `uso_percentual = limite_usado / creditLimit × 100`. Faixas: normal abaixo de 70%; atenção de 70% a 84,99%; alto de 85% a 94,99%; crítico a partir de 95%.

**Campos de origem.** `creditData.creditLimit`, `creditData.availableCreditLimit`, `creditData.disaggregatedCreditLimits[]`, `creditData.level`, `creditData.brand`, timestamp do snapshot.

**Contrato e widget.** `GET /api/v1/credit-card`. `LimitGauge` em destaque no topo, com valor usado, disponível, percentual, faixa e composição por limite desagregado quando houver.

**Exclusões e limitações.** Limite ausente ou menor/igual a zero retorna indisponível. O widget não interpreta limite disponível como saldo nem recomenda novo crédito. Limites desagregados não são somados ao total se forem apenas recortes do mesmo limite.

**Critérios de aceite.** Fixture com uso igual ou superior a 95% produz `critical`, texto “limite crítico” e tratamento visual de perigo; fronteiras das quatro faixas têm testes; ausência de limite não causa divisão por zero; o frontend não recalcula a faixa.

### 5.2 Fatura atual em formação

**Fórmula.** Agrupar transações do cartão pelo `creditCardMetadata.billForecastDate`. Para o ciclo atual, débitos e créditos são componentes separados por `POSTED`/`PENDING`. `fatura_líquida_observada = soma(DEBIT) − soma(CREDIT)` pode ser exibida como aritmética do ciclo, mas apenas `DEBIT POSTED` elegível compõe gasto confirmado. Crédito pareado com `role = CARD_CREDIT` é liquidação; crédito não pareado aparece como `card_credit_unclassified`, sem ser chamado de estorno, e torna a interpretação causal `partial`.

**Campos de origem.** vínculo local da conta, `date`, `status`, `type`, `amountInAccountCurrency`, `creditCardMetadata.billForecastDate`, `merchant.businessName`, `descriptionRaw`, `order`.

**Contrato e widget.** `GET /api/v1/credit-card`, com evidências via `GET /api/v1/transactions`. Card de total + gráfico por categoria + lista compacta dos maiores componentes. `cardNumber` não é persistido nem devolvido; o vínculo usa `accountId`.

**Exclusões e limitações.** Transação sem `billForecastDate` fica em grupo “ciclo não informado” e não é silenciosamente atribuída. Nenhum crédito é chamado de estorno sem fonte explícita que prove essa semântica. Parcelamento futuro não é projetado se a API não fornecer parcelas confiáveis.

**Critérios de aceite.** `POSTED` e `PENDING` aparecem separados; débito e crédito aparecem em componentes distintos; os dois lados de um pagamento pareado ficam fora de gasto; crédito não pareado mantém `quality = partial`; transação sem previsão continua auditável; soma das categorias coincide com sua composição elegível; nenhum número de cartão chega ao payload público.

### 5.3 Histórico de faturas

**Fórmula.** Não há reconstrução: cada ponto usa diretamente `totalAmount` da fatura. Delta mensal é `totalAmount_m − totalAmount_m-1`; pagamento mínimo relativo é `minimumPaymentAmount / totalAmount × 100` quando a base é positiva.

**Campos de origem.** Fatura: `id`, `dueDate`, `billClosingDate`, `totalAmount`, `totalAmountCurrencyCode`, `minimumPaymentAmount`, `allowsInstallments`, `financeCharges[]`.

**Contrato e widget.** `GET /api/v1/bills`. Gráfico de até 12 barras, uma para cada mês da janela consultada, e tabela compacta com valor, fechamento, vencimento e mínimo; clique abre os encargos da fatura.

**Exclusões e limitações.** A rota da Pluggy usa paginação diferente da de transações, mas essa diferença não vaza ao frontend. Fatura ausente não é estimada a partir de saldo. Meses sem retorno ficam como lacuna.

**Critérios de aceite.** Todas as faturas devolvidas dentro da janela de 12 meses aparecem ordenadas por fechamento, no máximo uma barra por mês; 12 é tamanho da janela, não cardinalidade presumida da fonte. Datas e moeda vêm do contrato; lacuna não vira barra zero; parcelamento só é indicado quando `allowsInstallments` informa suporte.

### 5.4 Contador de encargos

**Fórmula.** Enquanto a sobreposição não estiver provada, `encargos_observados_conservador = max(soma(financeCharges.amount das faturas no ano), soma(gasto confirmado nas categorias 15030000 e 02020000 no ano))`. A resposta conserva separadamente `finance_charges`, `iof_transactions` e `interest_transactions`, suas contagens e também a soma bruta dos componentes como diagnóstico não aditivo; ela não chama essa soma de custo total.

**Campos de origem.** `financeCharges[].type`, `financeCharges[].amount`, `billClosingDate`; transações `categoryId`, `status`, `type`, `amountInAccountCurrency`, `date`.

**Contrato e widget.** `GET /api/v1/credit-card` e detalhamento em `GET /api/v1/bills`. Enquanto `overlapStatus = UNVERIFIED`, card “Encargos observados neste ano” com o valor conservador, qualidade parcial, componentes não aditivos e comparação com ano/período anterior quando existir. O título “Quanto o crédito custou” só pode ser usado após deduplicação comprovada e nova versão de métrica.

**Exclusões e limitações.** O provedor pode representar o mesmo encargo na fatura e no extrato; por isso os componentes são evidência visível, mas não somável no headline enquanto `overlapStatus = UNVERIFIED`. Eventual deduplicação futura exige evidência, teste e `metricVersion` nova, não heurística silenciosa. `PENDING` fica fora.

**Critérios de aceite.** Fixture com encargo em fatura, IOF e juros transacionais exibe os três componentes sem somá-los no headline; `conservativeTotal` coincide com a maior soma por fonte; filtros do ano usam data local; cada componente abre evidências; `quality = partial` e nota metodológica permanecem visíveis enquanto a sobreposição não estiver confirmada.

### 5.5 Countdown de vencimento

**Fórmula.** `dias = data(dueDate em America/Sao_Paulo) − data(hoje)`. Valores positivos mostram “vence em N dias”; zero, “vence hoje”; negativos, “vencida há N dias”. A fatura aberta é a de vencimento futuro mais próximo que ainda não foi substituída por ciclo posterior; ambiguidade retorna estado parcial.

**Campos de origem.** `dueDate`, `billClosingDate`, `totalAmount`, `creditData.balanceDueDate`.

**Contrato e widget.** `GET /api/v1/credit-card`. `BillTimeline` com fechamento, hoje, vencimento e badge de urgência.

**Exclusões e limitações.** A API observada não informa confirmação de pagamento. Portanto, data passada não autoriza afirmar inadimplência; a cópia deve dizer “data de vencimento passou” e não “não paga”, salvo se uma futura fonte comprovar status.

**Critérios de aceite.** Virada de data segue São Paulo; hoje, futuro e passado têm testes; ausência de fatura aberta mostra estado vazio; nenhuma alegação de não pagamento é feita sem campo que a sustente.

## 6. Tela Recorrências

### 6.1 Radar de recorrentes

**Fórmula.** A chave é `merchant.cnpj` normalizado quando presente; senão, `descriptionRaw` normalizado. Para ocorrências `POSTED`, ordenar por `date`, calcular intervalos e valor mediano. Cadências aceitas inicialmente: semanal de 5 a 9 dias, mensal de 25 a 35, bimestral de 50 a 70, trimestral de 75 a 105 e anual de 330 a 400. `regularidade = intervalos dentro da faixa / total de intervalos`; `estabilidade = 1 − min(MAD(valores) / mediana(valores), 1)`. Se a mediana, que é o denominador, for menor ou igual a zero, estabilidade fica `null` e a série é `insufficient`/`not_comparable`. Fora disso, é recorrente quando há pelo menos 3 ocorrências, `regularidade ≥ 0,67`, `estabilidade ≥ 0,70` e a ocorrência mais recente não está atrasada mais que 1,5 cadência.

**Campos de origem.** `merchant.cnpj`, `merchant.businessName`, `descriptionRaw`, `date`, `status`, `type`, `amountInAccountCurrency`, `categoryId`, `accountId`.

**Contrato e widget.** `GET /api/v1/analytics/recurrences`. Lista em cards ordenada por custo anualizado, com nome provável, cadência, valor típico, próxima janela e escores. A evidência abre as ocorrências.

**Exclusões e limitações.** Exclui transferências internas, pagamento de fatura, créditos e encargos financeiros. `merchant.cnpj` identifica empresa, não necessariamente plano. Descrição normalizada pode fundir ou separar cobranças; por isso o rótulo é “recorrência detectada”, não “assinatura confirmada”. `PENDING` pode sinalizar a ocorrência atual, mas não treina o padrão.

**Critérios de aceite.** Fixtures nas fronteiras de cadência e estabilidade têm resultado determinístico; menos de 3 ocorrências não classifica; a mesma chave produz a mesma série; cada card lista evidências e confiança; CPF ou documento do pagador nunca participa da chave.

### 6.2 Alerta de reajuste

**Fórmula.** Para uma recorrência ativa com ao menos 3 valores anteriores, `base = mediana dos últimos 3 a 6 valores anteriores`; `limiar = max(10%, 2 × MAD/base)`. Há reajuste quando `valor_atual > base × (1 + limiar)`. A API devolve aumento absoluto, percentual, base e janela usada.

**Campos de origem.** Chave de recorrência, `date`, `status`, `type`, `amountInAccountCurrency`; estatísticas persistidas da recorrência.

**Contrato e widget.** `GET /api/v1/analytics/recurrences`. Badge “reajuste provável”, seta de antes/depois e callout no topo da tela quando o evento for novo.

**Exclusões e limitações.** Só usa débitos `POSTED`. Valor variável por consumo pode produzir alerta sem reajuste contratual; a cópia usa “subiu fora do padrão”, nunca afirma mudança de contrato. Créditos do cartão e cobrança proporcional inicial ficam fora da comparação.

**Critérios de aceite.** Aumento abaixo do maior limiar não alerta; acima alerta com base reproduzível; base zero ou amostra insuficiente retorna indisponível; atualizar uma pendência não dispara evento até `POSTED`.

### 6.3 Cobrança retomada após inatividade

**Decisão de produto.** A feature “assinatura fantasma por ausência de uso” está descartada. A Pluggy mostra cobrança, mas não mostra login, consumo ou utilização do serviço; afirmar que algo não é usado seria inventar dado.

**Versão mensurável e fórmula.** O produto detecta **cobrança recorrente retomada após inatividade de cobrança**. Uma série antes `ACTIVE` passa a `DORMANT` somente quando há cobertura completa e o atraso alcança duas cadências. Quando surge nova saída `POSTED` após hiato de pelo menos duas cadências e menor que doze meses, o registro passa a `status = RESUMED`, persiste `last_gap_days` e `resumed_at`; após a janela do episódio, nova ocorrência regular devolve `status = ACTIVE`. Isso prova apenas que a cobrança reapareceu depois de não aparecer no extrato.

**Campos de origem.** `matcher_type`, chave local, histórico de `date`, `status`, `type`, `amountInAccountCurrency`, `cadence`, `median_interval_days`, `last_gap_days`, `resumed_at`, `analysis_version` e cobertura.

**Contrato e widget.** `GET /api/v1/analytics/recurrences`. Card “Cobrança retomada”, com data anterior, data atual, duração do hiato e valores antes/depois.

**Exclusões e limitações.** Não usa nem alega dado de uso, cancelamento, contrato ou intenção. Falha de sincronização dentro do hiato invalida o alerta. Uma cobrança anual não é classificada com apenas um ano de histórico.

**Critérios de aceite.** A cópia nunca contém “você não usa”; série sem recorrência anterior não alerta; hiato com cobertura incompleta retorna `quality = partial`; o drawer mostra as ocorrências que sustentam a detecção.

### 6.4 Custo anualizado

**Fórmula.** Para cada recorrência, `custo_anual = valor_mediano × multiplicador`, com multiplicadores semanal `52`, mensal `12`, bimestral `6`, trimestral `4` e anual `1`. O total anualizado é a soma das recorrências ativas. Reajuste `POSTED` atualiza a mediana conforme a janela, não retroage o histórico.

**Campos de origem.** Cadência, valor mediano, moeda, estado ativo e chave de recorrência.

**Contrato e widget.** `GET /api/v1/analytics/recurrences`. Card principal “R$ X/ano em recorrentes”, barras por categoria e lista dos maiores componentes.

**Exclusões e limitações.** É projeção, não gasto realizado. Séries em outra moeda ficam separadas. Recorrência sem cadência classificada não entra no total e aparece como “possível recorrência”.

**Critérios de aceite.** Multiplicadores têm testes; total coincide com a soma dos cards ativos; moedas não são misturadas; rótulo “anualizado” e método ficam visíveis.

## 7. Tela Análises

### 7.1 Gasto por categoria com drill-down

**Fórmula.** `raiz = dois primeiros dígitos de categoryId`; `gasto_raiz = soma do gasto confirmado das subcategorias com o mesmo prefixo`. O nível seguinte agrupa pelo `categoryId` integral. O rótulo vem de `categories.descriptionTranslated`.

**Campos de origem.** `categoryId`, `date`, `status`, `type`, `amountInAccountCurrency`; tabela sincronizada `categories`; override local efetivo.

**Contrato e widget.** `GET /api/v1/analytics/categories`. Barras horizontais ordenadas e treemap opcional para até oito raízes; clique faz drill-down e abre evidências. “Outros” usa `99999999` e não recebe tradução inventada.

**Exclusões e limitações.** Exclui transferências internas, pagamento de fatura e `PENDING`. Override tem precedência sobre categoria original, mas a resposta conserva a origem para auditoria. Categoria ausente entra em “Sem categoria”, separada de “Outros”.

**Critérios de aceite.** Soma das raízes coincide com gasto confirmado do período; prefixo `04` não entra em gasto; rótulos vêm da tabela sincronizada; override altera todas as métricas dependentes após recálculo no backend.

### 7.2 Comparativo mês a mês por categoria

**Fórmula.** Para categoria `c`, `delta_abs = gasto_c_atual − gasto_c_anterior`; `delta_pct = delta_abs / gasto_c_anterior × 100` quando a base é positiva. Mês atual parcial compara somente os mesmos dias do anterior. O ranking de mudança usa módulo de `delta_abs`, mantendo o sinal.

**Campos de origem.** Mesmos campos da categoria, com `date` e período civil.

**Contrato e widget.** `GET /api/v1/analytics/categories`. Matriz categoria × mês, barras lado a lado e seção “o que mais mudou”.

**Exclusões e limitações.** Base zero resulta em “nova no período”, sem percentual infinito. Categorias com valor absoluto irrelevante podem ser agrupadas visualmente, mas permanecem no total e no drawer.

**Critérios de aceite.** Parcial compara dias equivalentes; base zero não divide; sinal e valor absoluto são coerentes; soma de categorias em cada mês bate o total canônico.

### 7.3 Ranking de estabelecimentos

**Fórmula.** Agrupar por `merchant.cnpj`; para cada chave, calcular gasto confirmado, quantidade, ticket médio e última ocorrência. Ordenar por gasto. Quando o CNPJ estiver ausente, agrupar por `descriptionRaw` normalizado numa seção distinta “identificação provável”, sem fingir que é CNPJ.

**Campos de origem.** `merchant.cnpj`, `merchant.businessName`, `merchant.category`, `merchant.cnae`, `descriptionRaw`, `date`, `status`, `type`, `amountInAccountCurrency`.

**Contrato e widget.** `GET /api/v1/analytics/merchants`. Ranking em barras com nome, total, quantidade e ticket; clique abre o histórico.

**Exclusões e limitações.** Exclui transferências internas, os dois lados de pagamentos de fatura, encargos e todos os créditos; crédito de cartão não pareado permanece no componente próprio, não no ranking de gasto. Empresas com múltiplos CNPJs permanecem separadas; nenhuma fusão por nome sem regra explícita.

**Critérios de aceite.** Registros com CNPJ e fallback nunca são misturados; soma dos grupos mais “demais” coincide com o total elegível; resposta não expõe CPF nem documento de pagador.

### 7.4 Possível cobrança duplicada

**Fórmula.** Um par candidato possui IDs distintos, mesma chave de estabelecimento, mesmo `valor(t)` e diferença de timestamp menor que 24 horas. A chave usa CNPJ; na ausência, descrição normalizada. Cada conjunto recebe chave de deduplicação estável formada pelos IDs ordenados.

**Campos de origem.** `id`, `merchant.cnpj`, `descriptionRaw`, `date`, `order`, `status`, `type`, `amountInAccountCurrency`, `accountId`.

**Contrato e widget.** `GET /api/v1/analytics/anomalies`. Card de alerta com as duas cobranças lado a lado, diferença de horário e ação somente de inspeção.

**Exclusões e limitações.** Exclui transferências internas, pagamentos de fatura, créditos e o mesmo `id` atualizado de `PENDING` para `POSTED`. Parcelas ou compras legítimas repetidas podem coincidir; o produto diz “possível duplicidade” e não permite excluir lançamento. Data sem hora confiável reduz a qualidade e usa `order` apenas para ordenação, não para inventar distância temporal.

**Critérios de aceite.** Mesmo `id` nunca alerta; intervalo igual ou superior a 24 horas não alerta; pares simétricos geram um único alerta; evidências são visíveis; nenhum botão apaga transação.

### 7.5 Anomalia `LOG_ZSCORE`

**Fórmula.** O detector versionado chama-se `LOG_ZSCORE`. Dentro da categoria mais específica com pelo menos 20 ocorrências nos últimos 12 meses, usar `x = ln(1 + valor(t))`, média `μ` e desvio-padrão amostral `σ`; `z = (x − μ) / σ`. Marcar saída atual quando `z ≥ 3`. Se a subcategoria não tiver amostra, tentar a raiz; se `σ = 0`, não calcular. Este método não é z-score robusto.

**Campos de origem.** `categoryId`, `date`, `status`, `type`, `amountInAccountCurrency`, classificação efetiva e flags de exclusão.

**Contrato e widget.** `GET /api/v1/analytics/anomalies`. Lista priorizada por z-score, com valor, média/desvio da amostra, categoria e distribuição compacta. Um pulso elétrico curto pode ligar o ponto à banda histórica, com intensidade derivada do bucket de severidade; fallback usa linha/ícone e texto.

**Exclusões e limitações.** Exclui transferências internas, liquidação de fatura, recorrências conhecidas e `PENDING`. Z-score aponta raridade estatística, não fraude. A transformação log reduz distorção de cauda, mas não elimina sazonalidade.

**Critérios de aceite.** Amostra menor que 20 e desvio zero não alertam; threshold 3 é testado na fronteira; o card usa “atípico”, nunca “fraude”; cálculo é reproduzível a partir da amostra identificada pela API.

### 7.6 Raio-X do PIX

**Fórmula.** Selecionar conta bancária com `operationType = PIX`. `PIX enviado = soma(DEBIT)`; `PIX recebido = soma(CREDIT)`. Agrupar contraparte por `merchant.cnpj`/`merchant.businessName` quando presente e, em fallback, por descrição sanitizada normalizada. Para cada contraparte: total, quantidade, ticket mediano e última data.

**Campos de origem.** `operationType`, `type`, `status`, `amountInAccountCurrency`, `date`, `merchant.businessName`, `merchant.cnpj`, `descriptionRaw`; nunca `paymentData.payer.documentNumber.value`.

**Contrato e widget.** `GET /api/v1/analytics/pix`. Duas colunas “enviados” e “recebidos”, ranking de destinatários, tendência mensal e composição por contraparte.

**Exclusões e limitações.** PIX entre contas próprias aparece em bloco separado e não entra em gasto/ranking de destinatários externos. CPF e documento do pagador são removidos antes da persistência bruta e não podem formar rótulo. Descrição insuficiente vira “Contraparte não identificada”.

**Critérios de aceite.** Soma dos grupos coincide com total enviado/recebido; `DEBIT` e `CREDIT` não se misturam; transferência interna fica separada; teste de contrato rejeita qualquer campo com CPF/documento.

## 8. Tela Poupança

### 8.1 Evolução e variação residual

**Fórmula.** A evolução usa snapshots reais de `bankData.closingBalance`. `variação_saldo = saldo_fim − saldo_início`; `variação_residual = variação_saldo − aportes_internos + retiradas_internas`, em que aportes e retiradas são apenas transferências próprias pareadas com confiança suficiente. `automaticallyInvestedBalance` forma série separada até sua relação com o saldo total ser confirmada.

**Campos de origem.** `bankData.closingBalance`, `bankData.automaticallyInvestedBalance`, timestamp do snapshot; transações da poupança `date`, `status`, `type`, `amountInAccountCurrency`, `accountId`.

**Contrato e widget.** `GET /api/v1/analytics/savings`. Linha de saldo, linha opcional de aplicação automática e card “variação residual após aportes/retiradas internas”. O rótulo “rendimento estimado” só pode substituir “residual” depois de confirmação documentada da semântica da conta/provedor e cobertura completa; até lá, `estimatedYield = null`.

**Exclusões e limitações.** Não reconstruir saldo anterior à primeira captura. O residual pode incorporar juros, tarifa, compra, ajuste do provedor, transação tardia ou mudança de escopo; não equivale a rendimento nem rentabilidade certificada. Transferência interna sem pareamento confiável rebaixa a qualidade. Não somar `automaticallyInvestedBalance` ao saldo sem confirmação semântica.

**Critérios de aceite.** Aporte conhecido é removido da variação residual; cobertura incompleta rebaixa a qualidade; ausência de investimento retorna empty state; nenhum ponto histórico é interpolado como observado. O termo “rendimento estimado” continua proibido até o gate semântico da fonte.

### 8.2 Meta derivada automaticamente

**Fórmula.** Para cada categoria elegível, `meta_mensal = média do gasto confirmado nos últimos 6 meses completos`; `progresso = gasto_confirmado_mês_atual / meta_mensal × 100`. O backend prioriza Alimentação e outras categorias com presença em pelo menos 4 dos 6 meses. A referência é recalculada no fechamento de cada mês.

**Campos de origem.** `categoryId`, categoria traduzida, `date`, `status`, `type`, `amountInAccountCurrency`, flags de exclusão.

**Contrato e widget.** `GET /api/v1/analytics/savings` e composição por `GET /api/v1/analytics/categories`. Barras de progresso “Seu padrão de 6 meses”, com realizado, referência e projeção.

**Exclusões e limitações.** Não é orçamento cadastrado nem recomendação profissional; é referência histórica automática. Outlier continua na média, mas o contrato também devolve mediana para contexto. Menos de 4 meses com atividade resulta em histórico insuficiente. Não há campo para editar valor no MVP.

**Critérios de aceite.** A referência muda apenas com novos meses fechados; gasto atual muda o progresso, não a base; histórico insuficiente não cria meta; o texto usa “referência” ou “padrão”, não “limite aprovado”.

### 8.3 Sequência sem gasto supérfluo

**Fórmula.** Para evitar classificação subjetiva aberta, a versão inicial define “discricionário” pelos prefixos Pluggy `08` Compras, `09` Serviços digitais, `14` Apostas e `21` Lazer. `streak = quantidade de dias civis completos consecutivos, terminando hoje, sem saída POSTED elegível nessas raízes`. O dia atual conta apenas quando encerrado; durante o dia, exibir “sequência até ontem” mais o estado de hoje.

**Campos de origem.** `categoryId` efetivo, `date`, `status`, `type`, flags de transferência/pagamento de fatura.

**Contrato e widget.** `GET /api/v1/analytics/savings`. Contador de dias, calendário compacto e legenda das categorias incluídas. Ao cruzar marco fechado pela API, `DeterministicCelebration`/Catalisador da Virada alinha três aros ao valor já conhecido, toca uma vez por `metricId` + limiar e não oferece repetição ou recompensa.

**Exclusões e limitações.** É uma convenção de produto, não julgamento moral. Exclui `PENDING`, transferências e liquidação do cartão. Categorias `11` Alimentos e bebidas e `12` Viagens não entram por misturarem necessidades e escolhas. Override de categoria pode recalcular a sequência.

**Critérios de aceite.** Lista de prefixos aparece no tooltip; timezone é São Paulo; dia atual incompleto não infla a sequência; transação fora das raízes não quebra streak; override elegível recalcula no backend.

## 9. Widget global de saúde do sistema

### 9.1 Estado da sincronização

**Fórmula/estado.** A API retorna o último sync bem-sucedido, último resultado, quantidade inserida/atualizada no ciclo, contagem `PENDING`, estado do item e `nextAutoSyncAt`. A proposta calibrável `STALE_POLICY_V1` só abre `stale` quando não há harvest posterior a `nextAutoSyncAt + 6h` e `dataThrough` tem ao menos 24h; se `nextAutoSyncAt` for nulo, usa idade de `dataThrough` mais o estado/erro do item. Buckets comuns ao widget e à outbox: 24–<72h `WARNING`, 72–<168h `HIGH`, ≥168h `CRITICAL`. A política será recalibrada com telemetria, de forma versionada, sem mudar silenciosamente a semântica.

**Campos de origem.** Item `status`, `nextAutoSyncAt`, erro de sincronização e eventual consentimento; registro local de execução com início, fim, inseridos, atualizados, cursor, resultado e falha; contagem de transações `PENDING`.

**Contrato e widget.** `GET /api/v1/system/health`. Indicador discreto no cabeçalho; clique abre popover com cinco valores: último sucesso, próxima atualização automática, estado do item, alterações no último ciclo e pendências. Falha mantém o último dado válido visível com badge stale.

**Exclusões e limitações.** `consentExpiresAt = null` impede countdown de consentimento. Nesse caso, o produto detecta falha/defasagem, não inventa data. Webhook recebido não significa sync concluído; o estado só fica saudável após harvest persistido.

**Critérios de aceite.** Os cinco valores aparecem; falha parcial não zera dashboard; data nula de consentimento não produz countdown; `PENDING` reflete o banco local; widget identifica explicitamente quando o último dado está stale.

## 10. Detalhamento e únicas escritas

### 10.1 Detalhamento de transações

`GET /api/v1/transactions` serve de evidência para cards. A visualização mostra descrição sanitizada, data, ordem, conta mascarada por apelido não sensível, valor, status, categoria, merchant quando permitido e motivo de inclusão/exclusão. Não mostra CPF, documento do pagador, titular, número de conta ou número do cartão.

A lista respeita paginação do contrato interno; o frontend nunca conhece nem concatena o cursor da Pluggy. Estado original e override são distinguíveis.

### 10.2 Override de categoria

O controle nasce numa transação existente, abre a taxonomia sincronizada e apresenta a sugestão atual. Confirmar chama `PUT /api/v1/transactions/:id/category-override` com `categoryId`, `ruleScope` fechado em `MERCHANT_CNPJ` ou `DESCRIPTION_RAW_NORMALIZED` e o `If-Match` opaco recebido na leitura. Não existe criação de categoria nem campo em branco. A API recalcula métricas afetadas e registra a regra para próximas ocorrências.

**Aceite.** Cancelar não persiste; confirmar uma categoria válida atualiza a transação e, após resposta/revalidação, todos os widgets dependentes; categoria ou enum inexistente é rejeitado; `If-Match` ausente recebe precondition required e versão stale recebe conflito sem overwrite; auditoria conserva categoria original, efetiva e momento do override.

### 10.3 Override de transferência interna

O controle mostra estado automático, evidência e resultado esperado no gasto. Confirmar chama `PUT /api/v1/transactions/:id/internal-transfer-override` com `If-Match` e exatamente três estados: `true` força interna, `false` força externa e `null` remove o override para voltar à detecção automática. Não há texto livre.

**Aceite.** `true` remove a transação de gasto, recorrências, merchants e anomalias; `false` a reinsere quando elegível; `null` remove a decisão humana; repetição com a mesma versão é idempotente; versão stale não sobrescreve atualização da fonte; auditoria conserva decisão automática e override.

### 10.4 Ações de IA sem estado financeiro

`POST /api/v1/ai/actions` aceita apenas ações allowlisted acionadas por controles de um clique. A chamada calcula contexto sanitizado e devolve uma resposta; não persiste lançamento, categoria, transferência, meta, recorrência ou outra decisão financeira. Telemetria/cache operacional sanitizado não transforma a ação em mutação financeira. Consulta livre existe somente na fase Hermes F7/H3.

A fase Hermes de clarificação, posterior à primeira integração, é a única exceção planejada ao zero-input: `UNKNOWN_TRANSACTION_NEEDS_CONTEXT` pode levar o Hermes a perguntar em canal privado e resolver contexto com `clarifications:write`. Esse fluxo não cria input no site, não aparece como controle humano desta UI e segue o contrato auditável de `14-integracao-hermes.md`.

### 10.5 Proibições de interface

Não haverá:

- tela de login, cadastro, perfil, convite ou recuperação de senha;
- botão de adicionar lançamento, conta, orçamento, meta ou assinatura;
- input de valor financeiro;
- importação de CSV/OFX/planilha;
- exclusão ou alteração do valor/data de transação;
- controle de tema;
- ação do Hermes ou de IA que escreva dado financeiro.

A última proibição vale para o site e para a primeira integração Hermes. A clarificação privada posterior é uma exceção nominada, versionada e fora da UI; não autoriza edição livre de valor/data nem mutações adicionais.

## 11. Critérios transversais de aceite

- Cada widget nomeado neste documento possui teste de contrato com fixture fictícia e teste visual dos estados ready, loading, empty, insufficient, stale e error aplicáveis.
- O valor exibido coincide com o payload da rota canônica; não há agregação de domínio em componentes, hooks ou utilitários do frontend.
- `POSTED`, `PENDING`, projeção e dado stale são visual e textualmente distintos.
- Toda composição fecha com o total do card ou explica uma diferença por arredondamento/moeda/qualidade.
- Datas de corte e countdown usam `America/Sao_Paulo`.
- Nenhuma resposta ou tela contém CPF, titular, número de conta, número de cartão, segredo ou identificador da integração.
- Em 360 px, todos os cards permanecem legíveis e evidências abrem sem overflow horizontal.
- Investimentos, empréstimos, faturas ou recorrências vazios degradam para empty state, sem erro global.
- As únicas mutações financeiras persistentes são as duas rotas de override listadas na seção 1; a ação allowlisted de IA é stateless quanto a finanças.
- Desligar WebGL conserva todas as métricas, evidências e ações; budgets, `prefers-reduced-motion`, `Save-Data`, perda de contexto e três breakpoints têm teste.
- Celebrações são determinísticas e deduplicadas por marco; nenhuma interação simula sorte, aposta ou loot box.
- Nenhum nome, likeness ou asset oficial de *Jujutsu Kaisen* chega à release pública sem gate de licença concluído.

## Pendências / a confirmar

- Confirmar se `bankData.closingBalance` já inclui `automaticallyInvestedBalance`; até lá, as séries ficam separadas e o valor não é somado duas vezes.
- Confirmar se `financeCharges` e os lançamentos nas categorias `15030000`/`02020000` representam eventos distintos ou podem duplicar o mesmo encargo; até lá, o contador exibe a composição e a ressalva metodológica.
- Confirmar a disponibilidade e precisão de hora/minuto em `date` para aplicar a janela de menos de 24 horas na possível duplicidade; `order` sozinho não substitui timestamp.
- Escolher licença aplicável ou os mascotes originais antes da produção de assets; sem licença, nomes/likeness oficiais permanecem somente como referência interna da documentação.
