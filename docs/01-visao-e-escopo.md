# PulsoFinanceiro — visão e escopo

## 1. Resumo do produto

O PulsoFinanceiro é um painel financeiro pessoal, de usuário único, que transforma automaticamente os dados já coletados pela Pluggy em indicadores acionáveis. O produto deve responder, sem digitação e sem importação manual, quanto foi gasto, como o ritmo do mês está evoluindo, qual é o custo do crédito, quais cobranças se repetem e se a sincronização continua saudável.

O nome **PulsoFinanceiro** foi escolhido porque comunica acompanhamento contínuo e sinais de saúde, em vez de contabilidade manual. O serviço será preparado para escutar apenas em `127.0.0.1:3040`. A decisão canônica de borda é publicar `pulso.cursar.space` por Cloudflare Tunnel + Access, com validação integral do JWT também no origin; Tailscale por proxy autenticador externo é fallback se Access se tornar inviável. Exposição humana sem identidade foi descartada. Qualquer publicação ou alteração de infraestrutura pertence a uma rodada posterior e exige autorização própria.

## 2. Problema

Os dados financeiros chegam de uma instituição conectada à Pluggy, mas permanecem dispersos entre conta corrente, poupança, cartão e faturas. Consultar saldos ou extratos isolados não responde, de maneira rápida e confiável:

- qual é o patrimônio líquido observável hoje;
- se o gasto do mês está acima do padrão pessoal;
- quanto do limite do cartão está comprometido;
- quanto juros, IOF e outros encargos custaram no período;
- quais cobranças são recorrentes, foram reajustadas ou reapareceram após um hiato;
- quais categorias, estabelecimentos e contrapartes PIX concentram as saídas;
- se os dados estão atualizados e quando a Pluggy fará a próxima atualização automática.

O risco central não é falta de dados, mas transformar dados assíncronos e mutáveis em números coerentes. Transações `PENDING` podem virar `POSTED` e mudar de valor; transferências entre contas próprias não são gasto; pagamentos de fatura não podem duplicar compras já contabilizadas; e nenhum número apresentado pode depender de cálculo escondido no frontend.

## 3. Usuário e contexto de uso

Há um único usuário: o proprietário dos dados e da infraestrutura. Isso implica:

- não existe cadastro, login, recuperação de senha, perfil, organização, convite ou administração de usuários;
- não existe tabela `users`, chave estrangeira de usuário ou isolamento multi-tenant;
- o aplicativo não implementa autenticação humana;
- a identidade humana é delegada ao Cloudflare Access com política para um único e-mail e sessão longa, mas o origin valida integralmente o JWT em toda `/api/v1/*`; não existe login/tabela de usuário próprios;
- o fato de uma requisição chegar pelo loopback não prova confiança, pois o Cloudflare Tunnel também entrega requisições em `127.0.0.1`.

O uso principal é uma consulta breve e recorrente pelo navegador, em desktop ou celular, com leitura imediata dos sinais mais importantes. O painel deve funcionar sozinho antes de qualquer integração com o Hermes.

## 4. Princípios de produto

### 4.1 Zero entrada manual

O usuário não digita lançamentos, orçamento, meta, recorrência ou saldo e não importa CSV. Todo valor nasce da Pluggy, de histórico calculado pelo backend ou de regra determinística documentada.

As únicas ações persistentes permitidas são:

1. aceitar ou ajustar, a partir de opções já apresentadas, a categoria sugerida para uma transação;
2. marcar ou desmarcar uma transação como transferência interna quando a detecção automática errar.

Não haverá campo de texto livre para criar dado financeiro. Ajustes futuros que exijam outra forma de escrita precisam de novo ADR e de autorização explícita.

### 4.2 Backend calcula; clientes apresentam

Toda métrica exibida é produzida pela API interna. O frontend pode formatar moeda, data, porcentagem e estado visual, mas não soma transações, não aplica regra de negócio e não reconstrói séries. Essa regra permite que, numa fase posterior, o Hermes leia exatamente os mesmos números sem replicar lógica de componentes.

### 4.3 Automação observável

A sincronização local colhe o que a atualização automática da Pluggy já trouxe. Ela não força atualização do item como rotina. Webhook deve ser avaliado como sinal primário de novidade, com reconciliação agendada obrigatória para cobrir evento perdido. O painel sempre informa a idade do dado, o último ciclo bem-sucedido, `nextAutoSyncAt`, o estado do item e o volume ainda `PENDING`.

### 4.4 Privacidade por minimização

O frontend nunca conversa com a Pluggy. Segredos e identificadores de integração permanecem no backend e fora do repositório. CPF, titular, número de conta, número do cartão e outros identificadores pessoais não aparecem em métricas nem são enviados à IA. O JSON bruto sanitizado pode ser preservado para auditabilidade, mas o CPF presente em `paymentData.payer.documentNumber` é removido antes da persistência; não é mantido nem mesmo como hash.

### 4.5 Tema escuro exclusivo

O produto tem apenas tema escuro, sem alternância para tema claro. Densidade de informação, contraste, estados semânticos e leitura de gráficos devem seguir o design system de `docs/08-design-system.md`; nenhuma tela pode herdar o tema padrão de um framework sem customização.

## 5. Escopo funcional

### 5.1 Aquisição e qualidade do dado

- autenticação servidor a servidor na Pluggy com token temporário mantido apenas em memória;
- sincronização de item, contas, categorias, transações e faturas;
- carga inicial de 12 meses e atualização incremental idempotente;
- upsert por `transaction.id`, preservando a transição de `PENDING` para `POSTED`;
- armazenamento de campos normalizados e JSON bruto sanitizado;
- sincronização das categorias oficiais e uso de `descriptionTranslated` como rótulo;
- detecção de transferência interna por categoria `04`, reforçada por heurística e pelo único override manual permitido;
- preparação de coleções vazias para investimentos e empréstimos, sem fabricar conteúdo;
- registro de execuções, falhas, estado do item e eventos que futuramente poderão gerar alertas.

### 5.2 Painel determinístico

O painel inclui:

- patrimônio observável, ritmo e projeção mensal, dia mais caro e calor por dia da semana;
- uso do limite, fatura em formação, histórico de faturas, encargos e vencimento;
- recorrências, reajustes, retomadas após hiato e custo anualizado;
- categorias, comparação mensal, estabelecimentos, possíveis duplicidades, anomalias e raio-X do PIX;
- evolução da poupança, variação residual após aportes/retiradas internas, metas derivadas e sequência sem gasto discricionário; o rótulo “rendimento estimado” só entra após confirmação documentada da semântica da fonte;
- saúde da sincronização em widget discreto;
- detalhamento por transações somente como explicação e auditoria dos indicadores, não como experiência principal.

As fórmulas, campos, limitações e critérios de aceite estão em `docs/09-telas-e-features.md`.

### 5.3 Inteligência artificial

A camada de IA é uma etapa posterior ao núcleo determinístico. Ela pode narrar agregados, responder perguntas sobre o extrato, explicar anomalias e auxiliar a categorização do que a Pluggy não classificou. A IA nunca é fonte de um número: todo valor citado deve vir de uma métrica identificável calculada pelo backend. Contexto enviado a modelos deve ser mínimo, agregado e sanitizado.

### 5.4 API interna reutilizável

O escopo inclui contratos versionados para o frontend e, futuramente, para consumidores de máquina. A primeira integração externa será somente leitura. Tokens de serviço, escopos e revogação serão independentes da proteção humana na borda.

## 6. Fora de escopo

Estão explicitamente fora desta rodada de planejamento e, salvo nova decisão, fora do MVP:

- qualquer arquivo de implementação, serviço iniciado, banco migrado, túnel criado ou configuração alterada;
- autenticação própria, tabela de usuários, senha, login social ou gestão multiusuário;
- lançamento, edição ou exclusão manual de transações;
- cadastro manual de orçamento, meta, assinatura, estabelecimento ou conta;
- importação de CSV, OFX, planilha ou extrato;
- iniciação de pagamento, transferência, negociação de dívida ou qualquer escrita no provedor financeiro;
- classificador de categorias criado do zero; a fonte primária é a taxonomia da Pluggy, com override dirigido;
- aplicativo móvel nativo; o alvo inicial é web responsiva;
- contabilidade fiscal, conciliação empresarial, carteira compartilhada ou suporte multi-moeda com conversão cambial;
- inferir uso real de serviços assinados. O extrato prova cobrança, não utilização;
- consumo de `/identity` sem caso de uso aprovado;
- integração operacional com Hermes nesta etapa. Hermes terá fase própria somente depois de o PulsoFinanceiro operar e ser verificável sozinho;
- escrita do Hermes em dados financeiros; a primeira integração prevista é leitura e consumo de eventos.

## 7. Regras de domínio invariantes

1. Uma transação é identificada pelo `id` da Pluggy e atualizada no lugar; mudança de estado não cria nova linha.
2. Métricas confirmadas usam `POSTED`. Valores `PENDING` aparecem separados como provisórios e só entram em projeções que declarem essa inclusão.
3. Transferência interna não entra em gasto, receita, ranking de estabelecimento, recorrência ou anomalia de consumo.
4. Pagamento da fatura de um cartão já acompanhado não pode contar novamente como gasto; a compra no cartão é a origem econômica.
5. Rótulos de categoria vêm de `descriptionTranslated`; o rollup de nível 1 usa os dois primeiros dígitos de `categoryId`.
6. Toda data de corte e countdown usa `America/Sao_Paulo`; timestamps são persistidos com fuso ou em UTC e convertidos na borda da API.
7. Valores de moedas diferentes não são somados sem taxa de conversão rastreável. Se não houver conversão, o widget separa por moeda ou assume estado indisponível.
8. Ausência de histórico suficiente produz estado “dados insuficientes”; nunca produz zero inventado.
9. Conta, cartão, investimento ou empréstimo sem resultados produz estado vazio funcional, não erro de tela.
10. A API interna é a única origem de métricas para frontend, IA e futura integração com Hermes.

## 8. Critérios de sucesso do produto autônomo

O PulsoFinanceiro está funcional sem Hermes quando todos estes resultados forem demonstrados com dados de teste fictícios e, em ambiente privado, com os dados reais:

- uma sincronização repetida não duplica transações e atualiza corretamente uma transação que muda de `PENDING` para `POSTED`;
- todos os widgets exibidos correspondem aos valores retornados pela API interna, sem cálculo de domínio no navegador;
- transferências internas e pagamento identificado de fatura não inflam o gasto consolidado;
- o cartão entra em estado visual crítico quando o uso do limite ultrapassa a faixa crítica definida;
- recorrência, reajuste e cobrança retomada após hiato mostram evidência transacional e não alegam conhecer uso do serviço;
- falha ou defasagem de sincronização fica visível sem impedir a leitura do último snapshot válido;
- os únicos controles de escrita são categoria e transferência interna;
- nenhuma rota do frontend, log, prompt ou exportação expõe segredo ou PII proibida;
- as telas são utilizáveis em larguras de 360 px, 768 px e 1440 px, apenas em tema escuro;
- o produto pode gerar eventos na outbox sem conhecer Discord, WhatsApp ou qualquer outro canal.

## 9. Restrições operacionais

- O processo web usará a porta reservada `3040` e bind em `127.0.0.1`.
- Na decisão Access, os hostnames planejados são `pulso.cursar.space` para o site protegido e `pulso-hooks.cursar.space` para o único endpoint de webhook; o fallback Tailscale não os cria e usa somente a reconciliação agendada.
- O banco local é SQLite, arquivo único, com WAL e chaves estrangeiras habilitadas; ele permanece fora do repositório.
- Segredos são lidos de arquivos de ambiente do servidor, nunca copiados para o frontend, documentação, log ou commit.
- O serviço não força update do item Pluggy na rotina normal; sincroniza após sinal de webhook e por reconciliação agendada.
- Nenhuma premissa de produção é validada apenas por build. Entrega exige sincronização real controlada, verificação dos contratos da API, teste visual e restauração de backup.

## Pendências / a confirmar

- O proprietário ainda precisa autorizar a implantação do Cloudflare Access/Tunnel e informar o único e-mail permitido; a decisão arquitetural está fechada e não autoriza alteração nesta rodada.
- Confirmar se o valor de `bankData.closingBalance` já incorpora `automaticallyInvestedBalance`, para impedir dupla contagem no patrimônio.
- Confirmar como o conector MeuPluggy expõe a expiração do consentimento quando `consentExpiresAt` é nulo; até lá, o produto alerta por falha ou defasagem de sincronização.
