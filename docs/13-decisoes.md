# 13 — Decisões arquiteturais

## Convenção

- **Aceita:** vinculante para a implementação.
- **Proposta:** recomendação técnica que depende de decisão ou teste indicado.
- **Adiada:** deliberadamente fora desta fase.

## ADR-001 — Nome PulsoFinanceiro

**Status:** aceita.

**Contexto:** o produto acompanha atualização, saúde financeira e alertas sem entrada manual.

**Decisão:** pasta e repositório `PulsoFinanceiro`; slug operacional `pulso-financeiro`.

**Alternativas:** `NexoFinanceiro`, mais centrado em integração; `PrismaFinanceiro`, mais centrado em visualização.

**Por quê:** “Pulso” comunica atualização contínua e condição atual, os dois eixos mais distintivos do produto.

## ADR-002 — Rodada 1 é documentação pura

**Status:** aceita.

**Contexto:** o pedido proíbe implementação.

**Decisão:** somente `README.md`, `.gitignore` e Markdown de planejamento. Snippets são contratos ilustrativos.

**Alternativas descartadas:** scaffold vazio, migration, `.env.example`, Dockerfile, scripts ou prova de conceito.

**Por quê:** mesmo um scaffold tomaria decisões de implementação e violaria a ordem aprovada.

## ADR-003 — Monólito modular Node/TypeScript

**Status:** aceita, versões exatas pendentes de compatibilidade.

**Contexto:** um usuário, uma porta, volume observado baixo e nenhuma necessidade demonstrada de escala horizontal. A contagem atual é telemetria/fixture de escala, não gate rígido nem cardinalidade presumida.

**Decisão:** Node 22, TypeScript estrito, Fastify, React/Vite e um deploy único que serve SPA, API e webhook; comandos/timers reutilizam módulos de domínio.

**Alternativas descartadas:** microserviços, Next.js com lógica mista, containers separados e frontend hospedado externamente.

**Por quê:** reduz portas, segredos, deploys e falhas sem apagar fronteiras de código.

## ADR-004 — SQLite no HD, sem Postgres e sem container

**Status:** aceita.

**Contexto:** um escritor efetivo, leitura local, volume baixo e requisitos cobertos por UPSERT/JSON1.

**Decisão:** `pulso_financeiro.sqlite`, WAL, `foreign_keys=ON`, `busy_timeout`, migrations versionadas e backup online.

**Alternativas descartadas:** PostgreSQL no container e banco no SSD.

**Por quê:** Postgres adicionaria serviço, porta, memória, backup e observabilidade sem ganho neste perfil. O HD é a localização de produção definida pela casa.

## ADR-005 — Valores monetários em unidades menores no banco

**Status:** aceita.

**Contexto:** `REAL` binário pode acumular erro de centavos.

**Decisão:** colunas normalizadas `*_minor INTEGER` e `currency_code`; conversão validada na borda. JSON da API usa decimal legível com moeda explícita.

**Alternativas descartadas:** somar `REAL`; guardar string sem contrato de escala.

**Por quê:** inteiro é exato para BRL e mantém agregação SQLite simples. Moedas com escala diferente exigem tabela/função ISO explícita.

## ADR-006 — Webhook-first, sem forçar update do item

**Status:** aceita.

**Contexto:** a Pluggy já executa auto-sync e expõe `nextAutoSyncAt`.

**Decisão:** webhook persiste sinal e aciona coleta; incremental diário e reconciliação semanal cobrem entrega perdida. Nenhum batch local chama atualização do item.

**Alternativas descartadas:** polling puro frequente e `PATCH`/update agendado do item.

**Por quê:** respeita o ciclo da Pluggy, reduz chamadas e latência, mantendo completude eventual.

## ADR-007 — Incremental por ingestão + reconciliação por cursor

**Status:** aceita.

**Contexto:** no ambiente medido, `/v2/transactions` não oferece filtro utilizável por `transaction.date`; `createdAtFrom` filtra detecção/ingestão.

**Decisão:** diário usa `createdAtFrom` com overlap e checkpoint atômico; webhooks atualizam/deletam por IDs; semanal percorre cursor para comparar. Early-stop por `date` fica desabilitado até garantia de ordenação.

**Alternativas descartadas:** janela móvel enviada como `from/to`; paginação por `page/limit`; `createdAtFrom` como única proteção contra updates/deletes.

**Por quê:** combina baixo custo cotidiano com reparo periódico e não depende de comportamento não garantido.

## ADR-008 — Medição local vence contrato público conflitante

**Status:** aceita.

**Contexto:** o endpoint legado já retornou 410, embora a doc cite disponibilidade; a referência atual cita `dateFrom/dateTo`, mas o tenant medido não os validou.

**Decisão:** usar somente `/v2/transactions` e não depender de filtros por data até teste exato no mesmo tenant.

**Alternativas descartadas:** escrever o plano apenas pela documentação ou assumir que `from/to` e `dateFrom/dateTo` são equivalentes.

**Por quê:** o software precisa operar no ambiente real, mantendo a divergência visível para reteste.

## ADR-009 — Cursor Pluggy é opaco

**Status:** aceita.

**Contexto:** `next` chega como query string completa.

**Decisão:** concatenar à URL base v2, validar origem/path e seguir até `null`; nunca decodificar ou reconstruir `after`.

**Alternativas descartadas:** extrair base64, inventar `pageSize` ou persistir cursor como checkpoint permanente.

**Por quê:** preserva compatibilidade e evita saltos/duplicatas por hipótese sobre formato interno.

## ADR-010 — UPSERT e tombstone

**Status:** aceita.

**Contexto:** `PENDING` vira `POSTED`; a Pluggy também emite updated/deleted e um ID pode ser substituído por delete+create.

**Decisão:** UPSERT por `transaction.id`, preservando overrides locais; deletes viram tombstone excluído das métricas e reconciliável.

**Alternativas descartadas:** append-only e hard delete imediato.

**Por quê:** append-only duplica; hard delete elimina auditabilidade e pode permitir ressurreição ambígua.

## ADR-011 — Raw JSON redigido, PII desnecessária removida

**Status:** aceita.

**Contexto:** raw ajuda evolução de schema, mas contém CPF e números sensíveis.

**Decisão:** reter somente o payload sanitizado necessário; remover CPF, `number`, `owner`, `taxNumber`, `cardNumber` e identity antes do commit.

**Alternativas descartadas:** raw integral, criptografar tudo sem seleção e hash de CPF.

**Por quê:** minimização reduz impacto. Hash de CPF continua enumerável e o produto não precisa desse vínculo.

## ADR-012 — Não consumir `/identity`

**Status:** aceita até novo caso de uso.

**Contexto:** a rota entrega CPF e nascimento; nenhuma feature atual precisa deles.

**Decisão:** não chamar nem modelar identity.

**Alternativas descartadas:** coletar “para o futuro”.

**Por quê:** dado sensível sem finalidade é passivo, não ativo.

## ADR-013 — Categorias Pluggy como taxonomia base

**Status:** aceita.

**Contexto:** existem 130 categorias traduzidas e hierárquicas.

**Decisão:** sincronizar `/categories`, usar `descriptionTranslated`, rollup pelo prefixo e regras locais de override por merchant/descrição; MCC é sinal auxiliar.

**Alternativas descartadas:** tradução manual e classificador próprio do zero.

**Por quê:** maximiza cobertura medida e limita IA aos casos realmente ambíguos.

## ADR-014 — Somente duas mutações financeiras no site

**Status:** aceita.

**Contexto:** o produto e a primeira integração Hermes são zero entrada manual.

**Decisão:** permitir override de categoria e de transferência interna, ambos sobre transação existente e com `If-Match` obrigatório. Categoria aceita apenas `MERCHANT_CNPJ` ou `DESCRIPTION_RAW_NORMALIZED`; transferência aceita `true`, `false` ou `null`, que remove o override.

**Alternativas descartadas:** lançamento, edição de valor/data, orçamento preenchido, importação CSV e cadastro de meta.

**Por quê:** preserva automação e impede uma segunda contabilidade manual. A clarificação Hermes posterior do ADR-025 é exceção nominada fora do site, não abertura genérica de escrita.

## ADR-015 — Métrica server-side e contrato único

**Status:** aceita.

**Contexto:** frontend e Hermes precisam citar o mesmo número.

**Decisão:** fórmulas vivem no domínio backend. Todo envelope métrico retorna `computedAt`, `dataThrough`, `period`, `metricVersion`, `quality`, contagens e moeda; `metricId` identifica somente valores métricos citáveis. Eventos usam `eventId`, ainda que possam referenciar métricas.

**Alternativas descartadas:** cálculo em React e recálculo independente no Hermes.

**Por quê:** evita divergência silenciosa e torna IA auditável.

## ADR-016 — Sem auth próprio; acesso na borda

**Status:** proposta, escolha humana pendente.

**Contexto:** um usuário não quer login, mas o site contém extrato e PII.

**Decisão (A):** Cloudflare Access por e-mail exato + OTP, sessão de até um mês; sem tabela `users`. O Tunnel usa `Protect with Access` **e** o origin valida integralmente o JWT, sem confiar no loopback. A arquitetura está fechada; DNS/Tunnel/política continuam pendentes de autorização operacional.

**Fallback:** **B**, somente se A ficar inviável e houver nova aprovação: Tailscale sem hostname público, por proxy autenticador externo que emite asserção curta assinada; sem token/sessão humana próprios. **C**, aberta, foi descartada porque aceite de risco não autentica leituras nem overrides.

**Por quê:** Access equilibra celular, conveniência e proteção; revalidação no origin fecha o bypass por loopback. O usuário ainda controla quando autorizar a implantação.

## ADR-017 — Host humano e webhook separados

**Status:** proposta.

**Contexto:** um bypass de path no host Access enfraquece a clareza da fronteira.

**Decisão proposta:** se houver publicação por hostname, `pulso.cursar.space` fica sob a política humana aprovada e `pulso-hooks.cursar.space` aceita apenas webhook autenticado. Ambos são nomes propostos e livres no inventário; DNS/Tunnel ainda não existem. O webhook será configurado no nível da aplicação Pluggy, sem `webhookUrl` simultâneo no Item.

**Alternativas descartadas:** webhook no mesmo host com `Bypass Everyone`; expor toda API.

**Por quê:** políticas e logs ficam inequívocos; uma falha no webhook não abre o painel.

## ADR-018 — API e outbox desacoplam Hermes

**Status:** aceita como arquitetura futura.

**Contexto:** canais e agentes mudam; alertas não podem depender de entrega síncrona.

**Decisão:** API `/api/agent/v1` com um `service_principals` por corpo/perfil e hashes `current`/`next`. `GET /events` é snapshot read-only; `POST /events/claim` concede lease com `events:claim`; ack exige `leaseToken`/`deliveryId` e `events:ack`. Claim/ack são escritas operacionais, não financeiras. `outbox_events` deduplica somente episódio ativo (`condition_closed_at IS NULL`); recuperação fecha o episódio e reincidência cria outro. O backend não conhece canal.

**Alternativas descartadas:** backend enviar Discord/WhatsApp e bot falar com bot.

**Por quê:** persistência, dedup, retry e Kanban respeitam a regra da frota.

## ADR-019 — IA barata, estruturada e subordinada às métricas

**Status:** proposta sujeita a benchmark.

**Contexto:** tarefas são narrativa/classificação leve; cálculo já é determinístico.

**Decisão:** primário `mistralai/mistral-small-3.2-24b-instruct` (US$ 0,075/M input e US$ 0,20/M output); fallback `google/gemini-2.5-flash-lite` (US$ 0,10/M input e US$ 0,40/M output); ZDR, data collection deny, JSON Schema e `metricRefs`. A ordem parte do menor custo documentado e só muda por benchmark. No site, somente ações allowlisted de um clique e sem persistência financeira; consulta textual livre começa no Hermes F7/H3.

**Alternativas descartadas:** modelos de raciocínio caros, variante gratuita em produção, envio de extrato inteiro.

**Por quê:** os dois têm preços oficiais baixos, fornecedores distintos e structured output; o Mistral custa menos nas duas direções. Fixtures sanitizadas podem justificar inverter a ordem por qualidade, nunca de modo silencioso.

## ADR-020 — OpenRouter key não é duplicada

**Status:** aceita.

**Contexto:** a chave já vive em `/home/server/.hermes/.env` modo 600.

**Decisão:** ler somente `OPENROUTER_API_KEY` desse arquivo em runtime; não importar/copiar o restante.

**Alternativas descartadas:** segundo `.env`, commit ou systemd carregar todas as chaves Hermes.

**Por quê:** uma única origem reduz drift e exposição lateral.

## ADR-021 — Investimentos e empréstimos degradam para vazio

**Status:** aceita.

**Contexto:** endpoints habilitados retornam zero hoje.

**Decisão:** schema e DTO aceitam coleção vazia; ingestão completa só após observar contrato real sanitizado.

**Alternativas descartadas:** esconder/quebrar tela ou inventar campos como se observados.

**Por quê:** prepara expansão sem afirmar dados inexistentes.

## ADR-022 — Backup pela Online Backup API

**Status:** aceita.

**Contexto:** copiar o arquivo principal com WAL ativo pode produzir backup incompleto.

**Decisão:** `.backup`/Online Backup, `integrity_check`, SHA-256, retenção e restauração em arquivo novo.

**Alternativas descartadas:** `cp` simples do `.sqlite` vivo e backup de WAL/SHM como conjunto informal.

**Por quê:** gera snapshot autocontido e verificável.

## ADR-023 — Fechamento no Segundo Cérebro exige gate de privacidade

**Status:** adiada.

**Contexto:** a integração deseja escrever fechamento mensal, mas o vault não foi aprovado como destino de dados financeiros privados.

**Decisão:** primeira integração não escreve no vault; etapa futura exige destino privado ou resumo explicitamente não sensível, além de lock/changelog.

**Alternativas descartadas:** publicar valores pessoais automaticamente.

**Por quê:** cumprir protocolo de escrita não resolve exposição do conteúdo.

## ADR-024 — 3D funcional, progressivo e com gate de direitos

**Status:** aceita como direção; assets dependem de gate.

**Contexto:** o frontend deve ser escuro, muito mais animado e usar 3D, com referências funcionais a Gojo/Six Eyes/Infinity, Kashimo/raios e Hakari/jackpot.

**Decisão:** traduzir as referências em leitura/proteção por camadas, pulso de fluxo/anomalia e celebração determinística de economia/streak. WebGL é lazy, opcional e limitado por budgets; HTML/SVG 2D contém o contrato completo e assume automaticamente em redução de movimento, economia de dados, hardware limitado ou falha. Não existe aposta, loot box ou resultado aleatório.

**Gate de direitos:** nomes, likeness e assets oficiais de Satoru Gojo, Hajime Kashimo, Kinji Hakari ou *Jujutsu Kaisen* não entram em release pública sem licença/autorização escrita. Sem licença, usar Sentinela de Camadas, Condutor do Pulso e Catalisador da Virada com design original e proveniência.

**Alternativas descartadas:** 3D bloqueando métricas; animação decorativa em loop; fan art/web asset sem licença; clone visual de personagem; gamificação de aposta.

**Por quê:** preserva a energia pedida sem sacrificar entendimento, performance, acessibilidade ou direitos.

## ADR-025 — Clarificação privada é exceção posterior ao zero-input

**Status:** adiada para F8 e dependente de gate próprio.

**Contexto:** algumas transações não têm descrição/sinais suficientes; uma pergunta privada pode produzir contexto reutilizável, mas a primeira integração Hermes deve continuar de leitura financeira.

**Decisão:** o detector pode criar `UNKNOWN_TRANSACTION_NEEDS_CONTEXT` como evento read-only; o backend não conhece canal e a primeira integração não aceita resposta. Em fase posterior, um principal isolado usa `clarifications:read_private` somente depois de escolher um Discord privado allowlisted: a rota `no-store` acrescenta data/valor/moeda indispensáveis para reconhecer o pagamento, sem conta, saldo, cartão, merchant/descrição/texto de operação, PII, ID externo ou fingerprint. `clarifications:write` é separado e resolve com `If-Match` + `Idempotency-Key` + `applyToSimilar`, aceitando apenas sugestão existente ou alias NFKC curto/validado; persiste outcome `CATEGORY_ONLY|CATEGORY_OVERRIDE|NORMALIZED_ALIAS`. Reaplica primeiro por CNPJ/descrição e, quando ambos faltam, somente por `transaction_context_rules` com `SOURCE_FINGERPRINT_V1/HIGH`, escopo de conta e gate de valor; a fingerprint permanece apenas no SQLite. A primeira reaplicação gera revisão privada informativa; se a decisão divergir, o mesmo commit desativa a regra e corrige sua application. Mensagem e resposta crua não entram em banco/log/IA/vault.

**Alternativas descartadas:** formulário no site, classificação livre por IA, habilitar escrita na primeira integração, pergunta em canal coletivo e backend acoplado ao Discord.

**Por quê:** fecha uma lacuna real com menor privilégio e repetibilidade, mantendo a exceção estreita, revogável e visível.

## Pendências / a confirmar

*(seção histórica do Codex — a versão atualizada está no fim do arquivo, após os ADRs 026–028)*

## ADR-026 — dateFrom/dateTo liberados como otimização, sem virar dependência

**Status:** aceita (24/08/2026, rodada Hermes-server).

**Contexto:** o contrato medido do Codex rejeitava `dateFrom`/`dateTo` por falta de teste. Teste controlado no tenant (Item MeuPluggy real) confirmou HTTP 200 com filtro por `date`, além de ordem decrescente observada e rejeição de `order`/`pageSize`.

**Decisão:** `dateFrom`/`dateTo` são permitidos como otimização de janela no harvest diário. O job continua obrigado a usar `createdAtFrom` + overlap e reconciliação full semanal; upsert idempotente permanece a proteção contra mudança de ordenação.

**Alternativas descartadas:** manter proibição total (perde otimização medida); depender do filtro de data (não cobre re-ingestão com `date` antigo).

**Por quê:** comportamento agora medido; a regra de autoridade (medido > doc) foi aplicada nas duas direções.

## ADR-027 — Arquétipos ganham mecânicas de jogo ligadas a métricas

**Status:** aceita como direção (rodada 24/08/2026, pedido do Álvaro).

**Contexto:** briefing pede front "bem bonito, muitas animações, itens 3D" com Gojo/Kashimo/Hakari e lógica que ajude a organizar e economizar.

**Decisão:** cada arquétipo recebe mecânica verificável — Sentinela (Domínio em Camadas + Infinito de cobrança futura), Condutor (raio por transação + laço de anomalia + carga semanal), Catalisador (roleta determinística de marcos + cofre de fragmentos). Mecânicas calculadas no backend (`milestone_events` idempotente), UI só celebra. Detalhes e budgets em `15-front-anime-mecanicas.md`. Gate de direitos da ADR-024 permanece.

**Alternativas descartadas:** animação decorativa desconectada de métrica; gamificação com moeda virtual/aposta; cálculo de marco no cliente.

**Por quê:** atende o briefing mantendo número-primeiro, acessibilidade, performance e direitos.

## ADR-028 — Integrações Discord seguem gate de mensagem canário

**Status:** aceita como direção (rodada 24/08/2026).

**Contexto:** auditoria viva confirma gateways ativos nos três corpos, mas entrega real em canal nunca foi provada sem mensagem ativa; heartbeat do acer estava congelado desde 22/08.

**Decisão:** nenhuma integração automática (I1–I8 de `16-integracoes-discord-hermes.md`) liga sem antes passar por mensagem canário num canal privado de teste com ack manual. Perfil `financas` no server é o único principal financeiro inicial. Handoff server→acer continua exclusivamente por Kanban.

**Alternativas descartadas:** ligar alertas direto na F7 sem prova de entrega; criar principal financeiro no Windows; bot falando com bot.

**Por quê:** outbox já protege o dado; o canário protege a entrega.

## Pendências / a confirmar (atualização 24/08, rodada Hermes-server)

- Aprovação humana dos ADRs 016 e 017: Access e hostname separado para webhook.
- Benchmark de 30–50 fixtures sanitizadas para confirmar ou inverter a ordem dos modelos do ADR-019.
- Teste do filesystem para tornar efetivas as permissões do ADR-004/022.
- Testes Pluggy listados em `04-integracao-pluggy.md` podem gerar novos ADRs; não alterar silenciosamente os existentes. *(Parcialmente cumprido nesta rodada: dois testes executados no tenant geraram ADR-026; os demais seguem pendentes.)*
- Concluir o gate de licença ou aprovar os mascotes originais antes de assets da ADR-024/027 (mecânicas não dependem do gate).
- Manter a ADR-025 bloqueada até aprovar principal, canal privado, retenção, rollback e testes de PII/idempotência.
- Álvaro aprovar lista I1–I8 de `16-integracoes-discord-hermes.md` antes da F7.
