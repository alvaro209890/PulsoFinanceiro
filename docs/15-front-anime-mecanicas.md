# 15 — Frontend anime aprofundado: personagens, mecânicas e economia

*(autor: Hermes-server | rodada 24/08/2026, a pedido do Álvaro — "quero um front bem bonito e com muitas animações, itens 3D e tema escuro, com Gojo, Kashimo e Hakari ajudando de verdade na organização")*

Este documento **estende** `08-design-system.md` e `09-telas-e-features.md`; nada aqui revoga tokens, budgets ou gate de direitos já definidos. O que muda é a profundidade: cada arquétipo ganha **mecânica de jogo real ligada a comportamento financeiro**, não só visual.

## 1. Princípio central

> Personagem não é enfeite: é **interface**. Cada um dos três arquétipos é um "sistema" que lê, protege ou celebra o dinheiro do usuário — e cada animação dele existe porque uma métrica real mudou.

Se remover os personagens sobrar informação faltando, o design está errado (regra 8 do design system).

## 2. Os três sistemas (arquétipos)

### 2.1 Sentinela de Camadas — referência Gojo / Six Eyes / Infinity

| Aspecto | Especificação |
|---|---|
| Papel no app | Guardião da Visão Geral. É quem "enxerga tudo em camadas". |
| Mecânica financeira | **Domínio em Camadas**: o patrimônio é apresentado como esferas concêntricas — saldo livre (núcleo), obrigação da fatura (anel 1), assinaturas/recorrências (anel 2), margem projetada até o fim do mês (borda). Tocar num anel abre a composição. |
| Animação assinatura | **Infinito**: quando uma cobrança futura conhecida (fatura prevista via `billForecastDate`, recorrência confirmada) se aproximaria do saldo livre, ela **desacelera visualmente** ao se aproximar do núcleo e para a 12 px dele, com rótulo "chega dia X". Nunca atravessa o núcleo — se atravessar, é sinal vermelho de saldo insuficiente projetado. |
| Estado saudável | Campo hexagonal translúcido "respirando" ao redor do patrimônio (`motion.ambient`), cor `color.energy.infinity`. |
| Estado de risco | O campo racha (linhas de fratura SVG) quando projeção fica negativa; sem loop, uma vez por mudança de estado. |
| 3D | Esferas concêntricas em Three.js lazy; fallback 2D = anéis SVG com a mesma interação. |
| Onde aparece | Visão geral (hero), tela Poupança (projeção). |

### 2.2 Condutor do Pulso — referência Kashimo / raios

| Aspecto | Especificação |
|---|---|
| Papel no app | Mensageiro das transações e sentinela de anomalias. |
| Mecânica financeira | **Raio de entrada/saída**: toda transação nova sincronizada percorre uma trilha elétrica do card da conta até o gráfico do mês — verde-água entrando, texto primário saindo. Intensidade proporcional ao valor (escala log, teto definido). |
| Detecção de anomalia | Quando o backend marca `LOG_ZSCORE` ou duplicidade suspeita, o raio **volta**: parte do gráfico e persegue a transação na lista, envolvendo a linha num laço elétrico com badge "olha isso". A revisão pelo usuário "desarma" o laço (override de categoria/transferência) — feedback imediato de que a ação resolveu. |
| Streak de dias revisados / sync saudável | Contador visual de carga elétrica acumulada (barra segmentada, máx 7 segmentos = semana). Perder sync por falha não zera a streak — só aviso amarelo; o usuário não é punido por problema de infra. |
| Proibição herdada | Nenhuma descarga decorativa sem evento; nenhum flash >3 Hz (acessibilidade §14 do design system). |
| Onde aparece | Feed de transações, widget de saúde do sistema, badge de anomalias. |

### 2.3 Catalisador da Virada — referência Hakari / jackpot

| Aspecto | Especificação |
|---|---|
| Papel no app | Celebrante determinístico de marcos de economia. **Nunca aleatório, nunca aposta** (ADR-024). |
| Mecânica financeira | **Roleta que não é roleta**: três anéis cinéticos giram quando um marco explícito é atingido — mas os três anéis sempre param alinhados no resultado já calculado. Marcos válidos: mês fechado abaixo da média dos 3 anteriores pela primeira vez, 3 meses seguidos sem estourar categoria, meta de reserva atingida, primeira transferência interna corretamente marcada. |
| Contraste Hakari real | No anime o jackpot é sorte; aqui o resultado é **sempre o mesmo que a métrica já provou** — a animação existe para dar peso ao feito, não suspense. Isso vai explícito no microcopy: "não foi sorte, foi constância". |
| Cofre da virada | Cada marco deposita um "fragmento" num cofre 3D na tela Poupança; o cofre mostra quantos fragmentos e qual marco cada um representa (tooltip com mês + métrica). Fragmentos são derivados do banco local, não moeda virtual — não há saldo, compra ou troca. |
| Frequência | `motion.celebration` uma vez por marco/dispositivo (já definido); cofre tem animação própria apenas ao receber fragmento novo. |
| Onde aparece | Overlay de celebração, tela Poupança, resumo mensal. |

## 3. Funcionalidades novas que os personagens desbloqueiam (resumo executável)

| # | Funcionalidade | Arquétipo | Métrica-fonte (API interna, já planejada) | Fase |
|---|---|---|---|---|
| F1 | Domínio em Camadas (patrimônio em esferas) | Sentinela | fechamento + obrigações + recorrências | F2 |
| F2 | Infinito de cobrança futura (alerta visual de chegada) | Sentinela | `billForecastDate` + saldo projetado | F3 |
| F3 | Raio por transação + laço de anomalia | Condutor | feed + eventos LOG_ZSCORE/duplicidade | F2/F4 |
| F4 | Carga semanal (streak de revisão) | Condutor | auditoria de overrides + saúde de sync | F4 |
| F5 | Roleta determinística de marcos | Catalisador | engine de marcos (nova tabela `milestone_events`) | F4 |
| F6 | Cofre de fragmentos | Catalisador | `milestone_events` agregados | F4 |
| F7 | Skins de temporada para os 3 arquétipos (paleta/forma, não roupa de personagem) | todos | cosmético puro, sem dado | F6+ |

**Nova tabela mínima** (detalhar em `05-modelo-de-dados.md` na implementação):

```sql
milestone_events (
  id TEXT PK,                -- ULID
  milestone_key TEXT,        -- 'MONTH_BELOW_AVG_3M', 'CATEGORY_STREAK_3M', 'RESERVE_GOAL_HIT', 'FIRST_TRANSFER_MARK'
  period TEXT,               -- 'YYYY-MM' ou data ISO
  computed_at TEXT NOT NULL, -- ISO
  celebrated_at TEXT         -- null = ainda não celebrado neste dispositivo
);
```

Regra: marcos são calculados **no backend**, idempotentes por `(milestone_key, period)`; a UI só marca `celebrated_at`. Nada de cálculo no cliente.

## 4. Microcopy dos personagens (pt-BR, tom seco)

- Sentinela: "Tudo em camadas. Nada passa batido." · risco: "Essa cobrança chega antes da reposição."
- Condutor: "Cada centavo deixa rastro." · anomalia: "Esse gasto foge do seu padrão."
- Catalisador: "Não foi sorte. Foi constância."

Proibido: fala de personagem real ("throughout heaven and earth…"), citação, onomatopeia de obra. Tom próprio, curto, funcional.

## 5. Direitos — reafirmação dura

Nomes Gojo/Kashimo/Hakari/Jujutsu Kaisen **não aparecem em nenhuma build pública** (ADR-024 e §12 do design system valem integralmente). Este doc é briefing interno. As mecânicas F1–F7 pertencem aos arquétipos originais (**Sentinela de Camadas**, **Condutor do Pulso**, **Catalisador da Virada**) e funcionam mesmo após substituição total da pele visual.

## 6. Budgets adicionais (sem revogar §11 do design system)

| Item | Limite |
|---|---|
| Animação simultânea de arquétipo visível | 1 por viewport |
| Partículas do pulso elétrico | ≤120 ativas |
| Trilha elétrica (SVG path draw) | ≤600 ms por transação |
| Esferas do Domínio (3D) | 4 meshes + 1 shader; ≤15k triângulos |
| Cofre de fragmentos | 1 mesh + instancing p/ fragmentos |
| Overlay de celebração | único, bloqueia scroll durante `motion.celebration`, dismissível por teclado (Esc) |

## 7. Pendências / a confirmar

- Decisão do Álvaro: mascotes originais vs. busca de licença (bloqueia skins públicas, não bloqueia mecânicas).
- Validar com benchmark real (F4) se overlay de celebração precisa variante reduzida para mobile intermediário.
- Definir se `milestone_events` nasce em F2 (só coleta silenciosa) e a UI consome em F4 — recomendado.
