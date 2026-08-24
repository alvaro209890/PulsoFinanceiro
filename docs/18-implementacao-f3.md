# 18 — Implementação da F3 (cartão e recorrências) e primeira conexão real

Diário da execução da fase F3 (`12-roadmap.md` §7), da configuração das
credenciais Pluggy e do primeiro harvest contra a conta real. Continua a
série iniciada em `17-implementacao-f2.md`.

Data: 2026-08-24. Estado: **implementado, testado e rodando contra dado real
em `127.0.0.1`**. Publicação com identidade de borda continua pendente (F6).

## 1. Conexão real

O Item da Pluggy foi configurado em `.env` (fora do Git — `.gitignore` bloqueia
`.env*`) e o harvest rodou contra a conta real do titular.

| Verificação | Resultado |
|---|---|
| `POST /auth` | 200, API key emitida pelo backend a cada ciclo |
| `GET /items/{id}` | `UPDATED` / `SUCCESS`, auto-sync ativo |
| Contas | 3 — corrente, poupança e cartão de crédito |
| Transações | 2.088 upsertadas em 6 páginas, ~2 s |
| Faturas | 12, com 57 encargos e 12 pagamentos |
| Pareamento de pagamento | 21 matches (11 `BANK_DEBIT`, 10 `CARD_CREDIT`), todos `HIGH` |
| Recorrências | 1 série mensal ativa |
| Canários de PII no JSON persistido | **0** em 2.088 linhas |

**Decisão do titular:** as credenciais expostas em conversa **não** serão
rotacionadas; o produto usa esse par. A recomendação técnica de rotação fica
registrada aqui, e a `.env` permanece fora do Git.

A API key colada na conversa continua sem uso: ela expira em minutos e o
backend emite a própria a cada ciclo, como `04-integracao-pluggy.md` exige.

### Correções que a conexão real revelou

1. **Sanitizador com furo.** A denylist não removia `cardNumber`,
   `identificationNumber`, `transferNumber` (agência/conta) nem `identity` —
   e o payload real do cartão traz `creditCardMetadata.cardNumber`. Agora
   `number` é substring proibida (fail-closed), somada a `identification` e
   `identity`. Teste com canário em cada chave.
2. **O servidor não subia no Windows.** A detecção de "fui executado direto?"
   fazia `argv[1].split('/')`, que no Windows não separa nada: o processo
   iniciava, não escutava porta e saía com código 0. Agora compara caminhos
   resolvidos.
3. **Séries fantasma.** A análise de recorrência nunca removia série que
   deixava de qualificar; a linha velha continuava afirmando um padrão que a
   análise atual não sustenta. A reanálise agora limpa o que não repersistiu.

## 2. O que a F3 entrega

### Cartão

`GET /api/v1/credit-card` (`credit-card.v1`) e `GET /api/v1/bills`
(`bills-history.v1`), em `src/finance/creditCard.ts`:

- **Uso do limite** com as quatro faixas nas fronteiras exatas (normal < 70%,
  atenção 70–84,99%, alta 85–94,99%, crítica ≥ 95%). Limite ausente ou ≤ 0
  devolve `UNAVAILABLE` sem dividir. Limites desagregados aparecem com
  `additiveToTotal: false` — são recorte do mesmo limite, não parcelas de uma
  soma.
- **Fatura em formação** agrupada por `creditCardMetadata.billForecastDate`
  (no tenant medido chega como `YYYY-MM`), com `POSTED` e `PENDING`
  separados, débito e crédito em componentes distintos, liquidação pareada
  distinguida do ajuste não classificado. Transação sem previsão vai para
  `cycleUnassigned` e nunca é atribuída em silêncio.
- **Countdown** com `dueDateStatus` em `FUTURE`/`TODAY`/`DUE_DATE_PASSED`. A
  fonte não informa confirmação de pagamento, então nada no payload — nem na
  interface — fala em inadimplência.
- **Encargos do ano** com `overlapStatus: UNVERIFIED`: o headline é
  `max(soma dos encargos das faturas, soma das transações 15030000/02020000)`
  e a soma bruta aparece apenas como `nonAdditiveComponentSum`. Na conta real
  as duas fontes deram exatamente o mesmo valor, o que reforça a suspeita de
  sobreposição registrada no plano — e é justamente por isso que nada é
  somado.
- **Histórico** direto do `totalAmount` da fonte, com delta mensal e mínimo
  relativo; mês sem fatura fica como lacuna, não como barra zero.

### Pareamento de pagamento de fatura (`MATCH_V1`)

`src/db/billMatch.ts` implementa o algoritmo fechado de `05-modelo-de-dados.md`:
valor absoluto **exatamente** igual, mesma moeda, distância civil de 0 dia
(`HIGH`) ou 1 dia (`MEDIUM`), candidato único por role. Empate, candidato já
ocupado ou pagamento sem data deixam a role sem match. Reexecutar a mesma
versão substitui apenas os matches derivados por ela.

Isso fecha uma lacuna da F2: a regra consolidada já excluía os dois lados do
pagamento, mas ninguém populava a tabela.

### Recorrências

`GET /api/v1/analytics/recurrences` (`recurrences.v1`), em
`src/finance/recurrences.ts`:

- chave por `merchant.cnpj` normalizado ou descrição normalizada
  (`DESC_NORM_V1`); documento do pagador nunca participa;
- cadências nas faixas fechadas do plano (5–9, 25–35, 50–70, 75–105, 330–400
  dias) com multiplicadores 52/12/6/4/1;
- classifica com ≥ 3 ocorrências, regularidade ≥ 0,67 e estabilidade ≥ 0,70;
  mediana ≤ 0 tira a série;
- estados `ACTIVE`, `DORMANT` e `RESUMED`, com `last_gap_days` e `resumed_at`
  persistidos. `DORMANT` fica fora do custo anualizado;
- reajuste com `base` na mediana das 3 a 6 cobranças anteriores e limiar
  `max(10%, 2 × MAD/base)`; a cópia diz "subiu fora do padrão".

### Eventos (sem canal, como manda o gate)

`CREDIT_LIMIT_BAND_CHANGED` (episódio por faixa, encerrado quando a faixa
muda), `BILL_DUE_SOON` (janela de 5 dias, `paymentStatusKnown: false`),
`RECURRENCE_PRICE_INCREASE` e `RECURRENCE_RESUMED_AFTER_GAP` (claim explícito
`CHARGE_REAPPEARED_AFTER_GAP`). A chave de dedup inclui tipo, entidade,
janela/ciclo e versão da política. Nenhum payload carrega descrição,
merchant, número de cartão ou saldo.

### Interface

Três destinos no shell único: Visão geral, Cartão e Recorrências. O medidor
de limite mostra as marcas de 70/85/95 e a cor da faixa vem da API. A tela de
recorrências mostra cadência, escores, confiança, estado e evidência.

## 3. Decisões desta fase

1. **Aplicação em investimento não é custo recorrente.** A raiz `03` da
   taxonomia sai da análise: a tela fala em custo anualizado, e dinheiro que
   sai para render não é custo. Sem isso, uma aplicação semanal aparecia como
   "R$ 5.200/ano em recorrentes".
2. **Série longa demais para o piso de regularidade.** Uma retomada cria um
   intervalo fora da faixa; com apenas 3 intervalos, 2/3 = 0,6667 fica abaixo
   do piso de 0,67 e a série conservadoramente não classifica. É o
   comportamento desejado (o plano pede conservadorismo), mas vale saber: uma
   série curta que hiberna e volta só aparece depois de mais ocorrências.
3. **Ciclo do cartão vem de `billForecastDate`, não de reconciliação com a
   fatura.** A soma do ciclo não bate com o `totalAmount` da fatura, porque a
   fatura inclui encargos e fecha em data própria. O plano manda usar o total
   da fonte no histórico e agrupar o ciclo pela previsão — é o que está feito,
   sem tentar conciliar os dois.
4. **Faixa de vencimento em 5 dias** para `BILL_DUE_SOON`, com severidade
   `HIGH` a 2 dias ou menos.
5. **Confiança da recorrência:** `HIGH` com ≥ 6 ocorrências, regularidade
   ≥ 0,8 e estabilidade ≥ 0,85; `MEDIUM` com ≥ 4 ocorrências e regularidade
   ≥ 0,7; `LOW` no resto.
6. **Referências a Jujutsu Kaisen na interface** — decisão do titular,
   registrada na ADR-031: uso pessoal e não comercial, referência **textual**
   ao lado da métrica, nenhum asset oficial no repositório. Se houver release
   pública, a ADR-024 volta a valer e os nomes saem antes.

## 4. Estado do gate de saída (roadmap §7)

| Item do gate | Estado |
|---|---|
| percentuais nas fronteiras de 70%, 85% e 95% retornam a faixa correta | **coberto** |
| fatura confirmada/provisória fecha com as transações do ciclo e não expõe número do cartão | **coberto** (inclui canário de `cardNumber`) |
| histórico preserva lacunas e não estima fatura ausente | **coberto** |
| recorrência exige amostra mínima e cada alerta abre evidências | **coberto** |
| nenhuma cópia afirma uso, cancelamento, fraude ou inadimplência sem dado | **coberto** por teste que varre o payload |
| repetir o cálculo no mesmo ciclo não duplica evento de outbox | **coberto** |

## 5. Onde está rodando

O produto saiu do notebook: roda no `server-desktop` como serviço de usuário
do systemd, com harvest diário automático.

| Item | Valor |
|---|---|
| Serviço | `pulso-financeiro.service` (systemd `--user`, `enabled` + `Linger=yes`, sobe no boot sem login) |
| Código | `/media/server/HD Backup/Servidores_NAO_MEXA/PulsoFinanceiro` (`npm run build`, executa `dist/`) |
| Banco | `/home/server/pulso-data/pulso.sqlite` — **ext4**, fora do HD externo |
| Segredos | `/home/server/pulso-data/pulso.env`, modo `600`, lido por `EnvironmentFile=` |
| Bind | `127.0.0.1:3040` |
| Acesso | `http://server-desktop:8080` via `tailscale serve` — **somente tailnet** |
| Harvest | agendado no processo, 04:30; carga inicial rodou 2.088 transações e 12 faturas |

Duas decisões de segurança valem registro:

1. **Os segredos não ficam no HD externo.** O `HD Backup` não guarda modo de
   arquivo (`chmod 600` vira `777` na prática), então `.env` mora no `ext4` e
   o `unit` aponta para lá com `EnvironmentFile=`. O `unit` também declara
   `After=`/`Wants=` do mount, para não subir antes do disco montar.
2. **Nada foi publicado na internet.** `tailscale serve` expõe apenas dentro
   da tailnet do titular; `tailscale funnel` (que seria público) continua
   desligado. A exposição por `pulso.cursar.space` com identidade validada no
   origin permanece na F6, como o roadmap manda — dado financeiro não vai para
   a internet aberta só porque é conveniente.

**Limite honesto do acesso atual:** qualquer dispositivo já autenticado na
tailnet abre o painel sem provar identidade de novo. Para o uso pessoal de um
titular só, isso é aceitável; para qualquer coisa além disso, vale a borda da
F6.

Comandos de operação:

```bash
ssh sd 'systemctl --user status pulso-financeiro.service'
ssh sd 'journalctl --user -u pulso-financeiro.service -n 50 --no-pager'
ssh sd 'curl -s -X POST http://127.0.0.1:3040/api/sync/run'   # harvest sob demanda
ssh sd 'tailscale serve --http=8080 off'                      # revogar o acesso
```

## 6. Como rodar localmente

```bash
npm install
cp .env.example .env       # preencher credenciais
npm run harvest            # ciclo completo contra a Pluggy (só contagens no log)
npm run dev                # painel em http://127.0.0.1:3040
npm test                   # 104 testes
```

## Pendências / a confirmar

- Webhook `pulso-hooks.cursar.space` continua sem provisionar na Pluggy: a
  aplicação não tem webhook configurado e o harvest agendado é o único
  gatilho hoje.
- Publicação humana exige a decisão de borda da F6; hoje o serviço escuta em
  `127.0.0.1` e só é alcançável pela tailnet.
- `overlapStatus` dos encargos segue `UNVERIFIED`; deduplicar exige evidência
  e nova `metricVersion`.
- Heurística conservadora de transferência interna (valores espelhados em
  contas do mesmo Item) ainda não implementada: hoje a exclusão vem da raiz
  `04` e do override.
