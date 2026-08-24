# 11 — Segurança e segredos

## Decisão de acesso e autorização pendente

**Status `ACCESS-001`: arquitetura decidida por Cloudflare Access; implantação/DNS ainda dependem de autorização humana.**

### Decisão A — Cloudflare Access

**Canônica.** O site continua sem login, senha, cadastro, sessão ou tabela de usuários próprios. A borda admite somente o e-mail exato do usuário por PIN de uso único e o origin revalida a prova.

Configuração futura mínima:

- aplicação self-hosted cobrindo todo `pulso.cursar.space/*`;
- política `Allow` com `Include = e-mail exato` e login por One-time PIN;
- durações global, aplicação e política ajustadas para **um mês**, máximo documentado atual; vale sempre a menor;
- PIN expira em 10 minutos;
- revogação de sessões testada para perda de aparelho ou comprometimento do e-mail;
- `Protect with Access` habilitado no Tunnel **e** validação completa do JWT no origin.

Ativar apenas o método One-time PIN sem restringir o e-mail permitiria qualquer endereço válido e é proibido.

Vantagens: acesso HTTPS normal no celular, nenhuma senha cotidiana e sessão longa. Dependências: conta Cloudflare, e-mail disponível e política bem configurada.

### Fallback B — Tailscale com proxy autenticador externo

Sem hostname público. Somente se A se tornar inviável e houver nova aprovação, um proxy autenticador externo ligado à tailnet recebe aparelhos autorizados, emite asserção curta assinada e encaminha ao backend em `127.0.0.1:3040`; o origin valida emissor, audiência, assinatura, prazo e identidade allowlisted. O PulsoFinanceiro não cria token, cookie ou sessão humana. Loopback/IP Tailscale isolados não são bypass.

### Exposição aberta — descartada

Qualquer pessoa com a URL poderia ler extrato, saldos, descrições, hábitos e alertas, além de tentar as duas mutações de override. `If-Match`, Origin, Fetch Metadata, JSON e rate limit não autenticam o cliente. Um aceite de risco não corrige isso; portanto esta opção não pertence ao roadmap.

## Regra do loopback

O backend fará bind em `127.0.0.1:3040`, mas **loopback não é identidade**. O Cloudflare Tunnel entrega requisições externas pelo loopback; outro processo local também pode chamar a porta.

Portanto, a autenticação de cada ramo é explícita:

- na decisão A, `/api/v1/*` exige JWT Access revalidado no origin, mesmo quando `cloudflared` já aplicou Access;
- no fallback B, `/api/v1/*` exige asserção assinada pelo proxy autenticador externo, sem hostname público;
- `/api/agent/v1/*` exige token de serviço e escopo;
- `/api/webhooks/pluggy` exige Bearer e controles próprios;
- somente liveness/readiness sem dados pode ser anônimo.

Esta regra é deliberadamente diferente do comportamento histórico do dashboard Hermes. Nenhum middleware pode implementar `remoteAddress is loopback => allow`.

## Validação do Cloudflare Access

Defesa em profundidade obrigatória: `Protect with Access` no ingress faz o `cloudflared` validar antes de encaminhar, e o backend usa `Cf-Access-Jwt-Assertion`, busca JWKS do team domain por HTTPS e valida novamente:

- assinatura RS256 e `kid` com rotação;
- `iss` exato do team domain;
- `aud` da aplicação;
- `exp` e `nbf`;
- e-mail exato permitido.

Confiar apenas em `Cf-Access-Authenticated-User-Email` ou no cookie sem validar o JWT é proibido.

## Isolamento do webhook

O host **proposto** `pulso-hooks.cursar.space` isolará o webhook para não criar um bypass público dentro do host financeiro. Ele estava livre no inventário, mas DNS, Tunnel e política ainda não existem.

Controles cumulativos:

1. aceitar apenas `POST /api/webhooks/pluggy`;
2. HTTPS obrigatório;
3. header `Authorization: Bearer <segredo>` configurado na Pluggy e validado em tempo constante;
4. WAF exigindo o header esperado sem registrar seu valor;
5. regra WAF de IP para a origem oficial atualmente publicada pela Pluggy (`52.67.145.81`), tratada como defesa adicional e revisada antes do deploy;
6. limite de corpo e `Content-Type: application/json`;
7. rate limit por IP e global;
8. deduplicação por `eventId`;
9. resposta sem dados e processamento assíncrono;
10. payload usado apenas como gatilho; toda verdade financeira vem de nova consulta autenticada à Pluggy.

A documentação oficial consultada não define assinatura HMAC da Pluggy. Não inventar header de assinatura. Se a Pluggy aceitar os dois headers de Service Auth do Access, essa proteção pode substituir a exposição pública; deve ser validada em sandbox antes.

## Inventário de segredos

| Nome | Onde vive | Quem lê | Nunca fazer |
|---|---|---|---|
| `PLUGGY_CLIENT_ID` | `/home/server/.config/pulso-financeiro/.env` | backend/coletor | frontend, Git, log, exemplo real |
| `PLUGGY_CLIENT_SECRET` | mesmo arquivo | backend/coletor | enviar ao navegador ou webhook |
| `PLUGGY_ITEM_ID` | mesmo arquivo | backend/coletor | DTO público, Git ou log |
| `PLUGGY_WEBHOOK_BEARER_TOKEN` | mesmo arquivo e configuração remota Pluggy | endpoint webhook | query string ou log |
| `OPENROUTER_API_KEY` | `/home/server/.hermes/.env` | adaptador OpenRouter | copiar para outro `.env` ou importar todas as chaves do Hermes |
| `PULSO_HERMES_API_KEY` | segredo privado de cada perfil chamador do Hermes | somente aquele principal | reutilizar entre perfis ou armazenar em banco/repo |
| hashes e escopos Hermes | registry SQLite `service_principals` | middleware de agente | persistir token puro, reduzir tudo a um principal singular ou logar hash completo |
| credenciais Cloudflare | arquivos próprios de `~/.cloudflared/` | `cloudflared` | copiar para o projeto |

O arquivo de configuração do PulsoFinanceiro deve ser modo `600`. O processo precisa receber somente as variáveis de que necessita.

## Gate `CRED-001` — credenciais expostas na conversa

Um Client ID, Client Secret e uma API key Pluggy foram fornecidos no canal de conversa. Os valores não são reproduzidos, copiados nem verificados neste repositório. Por terem atravessado o chat, devem ser tratados como expostos:

1. antes de qualquer implementação/chamada real, rotacionar o **Client Secret** no Dashboard Pluggy;
2. não reutilizar a API key colada; ela é efêmera e deve ser descartada, deixando o backend obter outra apenas em memória a partir das credenciais rotacionadas;
3. inserir os valores novos diretamente no arquivo privado aprovado, sem argumento de linha de comando, histórico de shell, log, Git, Segundo Cérebro ou mensagem;
4. registrar somente data/resultado da rotação, nunca valor ou fragmento;
5. bloquear F1 enquanto a rotação e a configuração privada modo `600` não forem confirmadas.

O Client ID também não será reproduzido em documentação/comandos, embora sua sensibilidade seja diferente da do Secret. Esta rodada não rotaciona nem usa credencial.

## Token Pluggy em memória

O `apiKey` retornado por `/auth`:

- existe somente em memória;
- não é persistido no SQLite, disco, cache externo ou log;
- tem validade medida de 2 horas;
- é renovado proativamente com margem e single-flight para evitar tempestade de auth;
- é descartado no restart e após erro de autenticação.

## Token de serviço Hermes

Emissão futura por principal:

1. gerar 32 bytes aleatórios com CSPRNG;
2. mostrar o token uma vez;
3. guardar o texto somente no secret store/`.env` privado daquele perfil Hermes;
4. criar uma linha em `service_principals` com `id`, `name`, `current_token_hash`, `next_token_hash`, `scopes_json`, `active`, datas de rotação/expiração/uso e revogação;
5. comparar hashes em tempo constante.

Cada corpo/perfil recebe principal e token independentes. Rotação sem interrupção: preencher `next_token_hash`, registrar `rotation_started_at` e `current_accept_until`, distribuir o novo token, aceitar `current` e `next` somente nessa janela e promover `next` atomicamente ao final. Revogação marca `active = 0`/`revoked_at` e invalida os hashes. Na primeira integração nenhum principal recebe escopo de escrita financeira; `events:claim` e `events:ack` são escritas operacionais da outbox.

`clarifications:read_private` e `clarifications:write` não entram no principal da primeira integração. São escopos de alto impacto, concedidos somente numa fase posterior a um principal/perfil específico depois de gate próprio; não podem ser combinados por conveniência com todos os tokens Hermes. O primeiro permite ler o contexto exato mínimo de uma pergunta vigente; o segundo permite resolver, mas um não implica o outro.

## Clarificação privada futura

O evento `UNKNOWN_TRANSACTION_NEEDS_CONTEXT` e sua resolução são exceção explícita ao zero-input, somente fora do site:

- o evento geral contém IDs locais, direção, data civil, faixa de valor e sugestões fechadas; não contém descrição crua, merchant, valor exato, CPF, CNPJ, conta/cartão, ID Pluggy ou nome de canal;
- depois de selecionar um destino privado allowlisted, o bridge pode chamar `GET /clarifications/:id` com `clarifications:read_private`; a resposta `Cache-Control: private, no-store` acrescenta somente data, valor exato e moeda, nunca conta, saldo, cartão, documento, merchant, descrição, texto de operação, ID externo ou fingerprint, e é apagada da memória após montar a mensagem;
- o backend não conhece Discord. O Hermes escolhe canal **privado** autorizado e monta botões; resposta textual opcional nunca é publicada em canal coletivo;
- resolução exige principal com `clarifications:write`, `If-Match` da versão da transação/clarificação, `Idempotency-Key` e `applyToSimilar` explícito;
- ações permitidas são aceitar uma sugestão de categoria existente ou definir alias normalizado NFKC de 1–60 caracteres que passe denylist; não há edição de valor, data ou descrição-fonte;
- texto do usuário é dado não confiável, nunca instrução para modelo/ferramenta. Sanitização, limite, caracteres de controle, segredo/PII e tentativa de prompt injection fecham a resolução;
- `applyToSimilar: true` só é aceito quando o backend já ofereceu CNPJ/descrição segura ou `SOURCE_FINGERPRINT_V1/HIGH`; a fingerprint usa sinais allowlisted e escopo de conta, fica apenas no SQLite e nunca entra em API, log, telemetria, IA, Discord ou vault;
- auditoria guarda principal local, versão, ação, escolha de reaplicação, regra criada/não criada e timestamps, mas não mensagem Discord nem PII; na primeira reaplicação de context rule, uma revisão privada oferece correção sem perguntar novamente “o que é”, e decisão divergente desativa a regra no mesmo commit;
- primeira integração Hermes permanece de leitura financeira; claim/ack da outbox são operacionais e não habilitam este fluxo.

## PII observada e tratamento

| Dado | Fonte | Persistência local | Frontend | IA/Hermes |
|---|---|---|---|---|
| `paymentData.payer.documentNumber.value` | transação | removido antes do raw JSON | nunca | nunca |
| `number` da conta | conta | não persistir | nunca | nunca |
| `owner` | conta | não persistir | nunca | nunca |
| `taxNumber` | conta | não persistir | nunca | nunca |
| `creditCardMetadata.cardNumber` | transação | remover antes do raw JSON | nunca | nunca |
| CPF e nascimento de `/identity` | identity | endpoint não consumido | nunca | nunca |
| descrição da transação | transação | necessária localmente | mostrar só ao usuário | somente amostra sanitizada quando indispensável |
| CNPJ/nome do merchant | merchant | necessário a ranking/recorrência | label útil; ocultar documento quando não necessário | remover documento; usar classe agregada |

Decisão: **remover**, não hashear, CPF/conta/cartão do raw JSON. CPF tem domínio pequeno e hash simples seria enumerável; como o produto não precisa do identificador, reter um pseudônimo não traz benefício.

## Sanitização antes de persistir

O sanitizador deve operar em cópia do objeto e aplicar exatamente a denylist canônica de `05-modelo-de-dados.md`:

```text
remover os subtrees paymentData.payer.documentNumber e paymentData.receiver.documentNumber
remover em qualquer profundidade as chaves owner, taxNumber, number, cardNumber,
identificationNumber e identity
percorrer recursivamente todos os objetos e arrays
reprovar o payload se qualquer chave/subtree proibida sobreviver
```

Uma allowlist de campos normalizados é preferível a copiar o payload inteiro e aplicar poucos deletes. O artefato persistível chama-se somente `raw_json_sanitized`; ele passa por teste automatizado com fixtures contendo valores-canário e por uma varredura de CPF/chaves proibidas antes do commit SQLite. Não existe um segundo contrato chamado “raw redacted”.

## Sanitização antes da IA

Pipeline obrigatório e separado do sanitizador de persistência:

1. buscar métricas e amostras mínimas;
2. substituir labels pessoais por aliases efêmeros quando não forem necessários;
3. remover CPF, `owner`, `taxNumber`, números de conta/cartão, IDs Pluggy, CNPJ e payload de pagamento;
4. limitar período, registros e caracteres;
5. validar JSON contra schema allowlisted;
6. só então chamar OpenRouter.

Uma falha de sanitização fecha o circuito: a chamada não é enviada.

## Banco, backup e filesystem

- banco e backup fora do Git;
- arquivo e backups com intenção de modo `600`, diretórios `700`, `UMask=0077`;
- WAL e SHM com mesma proteção;
- backup consistente e teste de integridade;
- restauração em arquivo novo;
- nenhuma cópia para Downloads, pasta pública ou artefato de CI;
- retenção documentada em `03-infra-e-deploy.md`.

O volume observado reporta modo `777`. Antes de dados reais, é gate obrigatório provar que permissões são aplicáveis. Se não forem, escolher controle de acesso do mount ou criptografia em repouso; não aceitar PII num volume mundialmente legível.

## Segurança HTTP

- CSP sem `unsafe-inline`/`unsafe-eval` na build final;
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`;
- HSTS e HTTPS na borda;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- CORS desabilitado por padrão; origin humano exato quando indispensável;
- writes exigem `application/json`, `Origin` exato e Fetch Metadata `same-origin`;
- respostas da IA são texto estruturado escapado; nunca HTML confiável;
- limites estritos de body, query, período e paginação;
- dependências travadas e auditadas antes do deploy.
- WebGL e assets 3D são self-hosted, sob a mesma CSP; shader/modelo não pode carregar URL, script ou textura remota em runtime.

## Direitos e cadeia de assets visuais

- Nenhum nome, likeness, frame, áudio, modelo, logo ou asset oficial de Satoru Gojo, Hajime Kashimo, Kinji Hakari ou *Jujutsu Kaisen* entra em release público sem licença/autorização escrita aplicável.
- Fan art, asset “encontrado”, modelo gerado parecido e URL remota são tratados como não aprovados.
- Cada fonte, modelo, textura, fonte tipográfica e áudio futuro precisa de manifesto local com autoria, origem, licença, escopo e data da aprovação.
- Sem licença concluída, a build publica somente os mascotes originais e distintos definidos no design system; o scanner de release inclui nomes/arquivos proibidos e revisão visual humana.
- Asset 3D passa por validação de formato/tamanho e não carrega script, referência externa ou metadado pessoal.

## Logs

Permitido: timestamp, request ID, rota parametrizada, status, duração, modo de sync, contagens, código de erro sanitizado e hash curto não reversível para correlação.

Proibido: headers de auth, body, query de IA, descrição, merchant, CPF, saldo, valor, IDs Pluggy, cursor `next`, raw JSON ou segredo mascarado parcialmente.

`sync_runs`, `webhook_inbox` e `outbox_events` guardam estado operacional mínimo; journald não substitui essas tabelas.

## Repositório público

Antes de todo push:

1. listar exatamente o que será commitado;
2. procurar `.env`, bancos, dumps, exports e logs;
3. procurar padrões de secret, Bearer/JWT, CPF, UUID e identificadores Pluggy;
4. revisar exemplos monetários como fictícios;
5. confirmar que nenhum dado real entrou no histórico;
6. se segredo entrar, parar, rotacionar e limpar histórico antes de publicar — remover só no commit seguinte não basta.

## Threat model resumido

| Ameaça | Controle principal |
|---|---|
| URL descoberta | Access por e-mail exato + JWT no origin; fallback B sem hostname público + proxy autenticador externo; sem ramo aberto |
| Tunnel tratado como auth | JWT/Service Token por rota; nunca loopback |
| webhook forjado | Bearer + WAF + idempotência + reconsulta Pluggy |
| replay de webhook | `eventId` único e inbox persistida |
| XSS lendo extrato | CSP, escape, sem HTML da IA |
| CSRF nos dois overrides | Origin + Fetch Metadata + JSON |
| vazamento via prompt | allowlist + sanitizador fail-closed |
| clarificação maliciosa/PII no Discord | canal privado + escopo dedicado + allowlist/NFKC/denylist + auditoria sem mensagem |
| vazamento via Git | ignore + scanner + revisão staged |
| token Hermes comprometido | hash, escopo mínimo, rotação e revogação |
| backup inconsistente/exposto | online backup, integridade e permissão |
| asset sem direito ou supply-chain remoto | gate de licença/proveniência + self-host + CSP + fallback original |

## Pendências / a confirmar

- **Usuário:** autorizar operacionalmente A (Cloudflare Access) ou, somente se houver impedimento documentado, aprovar B (Tailscale + proxy autenticador externo). C foi descartada.
- **Usuário/Cloudflare:** informar o e-mail exato somente na configuração privada da política; nunca neste repo.
- No caminho A, aprovar a criação dos hostnames propostos; `pulso.cursar.space` e `pulso-hooks.cursar.space` ainda não existem. No fallback B, esta pendência não se aplica.
- Validar se o mount honra `chmod`; sem isso, dados reais não podem ser persistidos no local planejado sem controle compensatório aprovado.
- Confirmar no ambiente Pluggy que headers customizados e o IP publicado continuam válidos; revisar antes do deploy.
- Validar em integração `Protect with Access` **e** a revalidação JWT no backend, inclusive negação por chamada direta ao loopback.
- Aprovar separadamente o principal, canal privado e política de retenção antes de conceder `clarifications:read_private`/`clarifications:write`; a primeira integração não recebe esses escopos.
- Concluir gate de licença ou aprovar mascotes originais antes de adicionar qualquer asset de personagem à release.
