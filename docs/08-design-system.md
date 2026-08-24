# PulsoFinanceiro — design system

## 1. Direção visual

O PulsoFinanceiro deve parecer um instrumento de leitura financeira contínua: escuro, preciso, energético e calmo quando tudo está normal; incisivo quando há risco. A interface usa hierarquia tipográfica forte, superfícies profundas, números tabulares, gráficos legíveis e movimento responsivo que transforma atualização, proteção e conquista em fenômenos visuais — sem encobrir o dado.

O tema escuro é obrigatório e exclusivo. Não existe tema claro, botão de alternância nem variante automática baseada no sistema operacional. Todos os componentes e bibliotecas de terceiros devem ser adaptados aos tokens deste documento.

## 2. Princípios

1. **Número primeiro:** valor, unidade, período e estado devem ser entendidos antes da ornamentação.
2. **Sinal com contexto:** vermelho indica risco ou perda apenas quando acompanhado de texto, ícone ou padrão; cor isolada nunca comunica estado.
3. **Densidade legível:** mais informação cabe na tela por agrupamento, alinhamento e progressive disclosure, não por fonte pequena.
4. **Origem evidente:** todo indicador oferece período, horário de atualização e acesso à explicação transacional.
5. **Movimento funcional:** animação indica atualização, fluxo, proteção, transição ou conquista. Loops ambientais são raros, lentos, pausam fora da viewport e nunca comunicam dado sozinhos.
6. **Zero formulário financeiro:** não há componentes para criação manual de lançamento, orçamento ou meta. Os únicos controles persistentes são seleção de categoria sugerida e marcação de transferência interna.
7. **Fantasia subordinada ao contrato:** 3D e efeitos ampliam uma métrica já calculada; remover WebGL deve preservar informação, ação e hierarquia.
8. **Referência não é licença:** personagens conhecidos servem apenas como arquétipos internos enquanto direitos e assets não forem autorizados para publicação.

## 3. Arquétipos visuais funcionais

As referências de *Jujutsu Kaisen* são uma linguagem de direção criativa interna, não autorização para copiar assets ou likeness:

| Referência interna | Tradução financeira | Uso funcional | Proibição |
|---|---|---|---|
| Satoru Gojo / Six Eyes / Infinity | leitura em camadas, clareza e barreira de proteção | anéis concêntricos no patrimônio separam saldo, obrigação da fatura, provisório e margem; um campo protetor se fecha quando dado/Access está saudável | olho, rosto, cabelo, roupa, símbolo, fala, pose ou asset reconhecível sem licença |
| Hajime Kashimo / raios | pulso de entrada/saída, descarga e exceção | trilhas elétricas direcionais percorrem séries somente quando chega dado novo; anomalia `LOG_ZSCORE`, sync e streak recebem um pulso de intensidade proporcional e rotulado | silhueta, figurino, retrato, ataque ou frame do personagem |
| Kinji Hakari / jackpot | virada e celebração determinística | três aros/painéis cinéticos convergem no valor já calculado quando uma economia ou streak cruza marco explícito | aleatoriedade, aposta, loot box, prêmio, moeda virtual, “tente de novo” ou promessa de ganho |

Sem licença, os nomes acima não aparecem na interface pública. Os equivalentes originais previstos são **Sentinela de Camadas** (leitura/proteção), **Condutor do Pulso** (fluxo/anomalia) e **Catalisador da Virada** (conquista determinística). Eles precisam de silhueta, paleta, lore e animação próprias, sem imitar design de personagem existente.

## 4. Tokens de cor

Os nomes abaixo são canônicos. Componentes não devem usar valores hexadecimais diretamente; usam o token semântico correspondente.

| Token | Valor | Uso obrigatório |
|---|---:|---|
| `color.canvas` | `#070A0F` | fundo global |
| `color.surface.1` | `#0D121A` | cards e navegação |
| `color.surface.2` | `#131A24` | cards elevados, popovers e drawer |
| `color.surface.3` | `#1A2330` | hover, seleção e skeleton |
| `color.border.subtle` | `#202B3A` | divisores e bordas normais |
| `color.border.strong` | `#344258` | foco estrutural e separação forte |
| `color.text.primary` | `#F4F7FB` | títulos, números e conteúdo principal |
| `color.text.secondary` | `#AAB6C6` | rótulos e explicações |
| `color.text.muted` | `#778397` | metadados e eixos |
| `color.text.inverse` | `#041017` | texto sobre preenchimento claro |
| `color.brand.primary` | `#38D6C7` | ação primária, seleção e série principal |
| `color.brand.hover` | `#63E2D6` | hover da ação primária |
| `color.brand.subtle` | `#103A3A` | fundo de seleção e destaque da marca |
| `color.info` | `#5DA9FF` | informação e série comparativa |
| `color.success` | `#42D392` | entrada, melhora e sincronização saudável |
| `color.warning` | `#F6C85F` | atenção e dados provisórios |
| `color.danger` | `#FF667A` | risco crítico, vencido e erro |
| `color.accent.violet` | `#A78BFA` | recorrências e projeções |
| `color.accent.orange` | `#FF9E64` | encargos e faixa alta do cartão |
| `color.energy.infinity` | `#86B7FF` | anéis de leitura/proteção e foco de camada |
| `color.energy.pulse` | `#36E7FF` | fluxo elétrico, dado novo e anomalia |
| `color.energy.celebration` | `#FFD166` | marco determinístico atingido |
| `color.overlay` | `rgba(2, 5, 9, 0.72)` | backdrop de drawer e modal |

### 4.1 Semântica financeira

- Entrada confirmada usa `color.success`, sinal `+` e rótulo “entrada”.
- Saída usa texto primário; vermelho é reservado para aumento desfavorável, estouro, atraso ou anomalia, não para toda despesa.
- Dado `PENDING` usa `color.warning`, contorno tracejado e rótulo “provisório”.
- Projeção usa `color.accent.violet` e linha tracejada; nunca é visualmente idêntica a realizado.
- Transferência interna usa `color.text.muted`, ícone de duas setas e rótulo explícito “fora do gasto”.
- Estado stale usa `color.warning`; indisponível usa texto muted e motivo, nunca o valor `0`.

### 4.2 Paleta de gráficos

A ordem de séries categóricas é `#38D6C7`, `#5DA9FF`, `#A78BFA`, `#FF9E64`, `#F6C85F`, `#42D392`, `#E879F9`, `#7DD3FC`. Depois da oitava série, agrupar o restante em “Outros”; não reciclar cores indistinguíveis no mesmo gráfico.

Para comparação temporal, realizado usa verde-água sólido, período anterior usa azul com 55% de opacidade e projeção usa violeta tracejado. Escalas de calor usam cinco passos de `#111923` a `#38D6C7`; célula crítica pode usar `#FF667A`, sempre com legenda textual.

## 5. Tipografia

### 5.1 Famílias

- **Interface e títulos:** Inter Variable, hospedada localmente, com fallback `system-ui`, `Segoe UI`, sans-serif.
- **Números, códigos e timestamps:** JetBrains Mono Variable, hospedada localmente, com fallback `Consolas`, monospace.

Não carregar fontes por CDN. Valores monetários usam algarismos tabulares para evitar deslocamento durante atualização.

### 5.2 Escala

| Token | Tamanho/linha | Peso | Uso |
|---|---:|---:|---|
| `type.display` | `40/44 px` | 650 | patrimônio e número principal em desktop |
| `type.h1` | `28/34 px` | 650 | título de tela |
| `type.h2` | `20/26 px` | 620 | seção |
| `type.h3` | `16/22 px` | 620 | título de card |
| `type.metric.lg` | `28/32 px` | 650 | indicador destacado |
| `type.metric.md` | `20/26 px` | 620 | indicador de card |
| `type.body` | `14/21 px` | 450 | texto normal |
| `type.label` | `12/16 px` | 560 | rótulo e cabeçalho de tabela |
| `type.caption` | `11/15 px` | 500 | fonte, horário e observação |

Em telas abaixo de 480 px, `display` reduz para `32/36 px`; nenhum texto funcional fica abaixo de 11 px. Títulos usam tracking levemente negativo; labels em caixa normal, sem blocos inteiros em caixa alta.

## 6. Espaçamento, grade e dimensões

### 6.1 Escala de espaçamento

| Token | Valor |
|---|---:|
| `space.0` | `0` |
| `space.1` | `4 px` |
| `space.2` | `8 px` |
| `space.3` | `12 px` |
| `space.4` | `16 px` |
| `space.5` | `20 px` |
| `space.6` | `24 px` |
| `space.8` | `32 px` |
| `space.10` | `40 px` |
| `space.12` | `48 px` |
| `space.16` | `64 px` |

### 6.2 Layout responsivo

- **Desktop, ≥ 1280 px:** navegação lateral de 248 px; conteúdo em 12 colunas; largura máxima de 1600 px; gutter de 24 px.
- **Tablet, 768–1279 px:** navegação compacta de 72 px; conteúdo em 8 colunas; gutter de 20 px.
- **Mobile, 360–767 px:** navegação inferior com até cinco destinos; conteúdo em 4 colunas; margem de 16 px; cards em uma coluna.
- Cards de métrica ocupam no mínimo 220 px; gráficos principais, no mínimo 320 px de largura ou toda a coluna no mobile.
- Área clicável mínima é 44 × 44 px. O conteúdo nunca depende de hover.

## 7. Forma, borda e elevação

| Token | Valor | Uso |
|---|---:|---|
| `radius.sm` | `6 px` | chips e controles compactos |
| `radius.md` | `10 px` | botões, selects e tooltips |
| `radius.lg` | `16 px` | cards |
| `radius.xl` | `22 px` | painel principal e drawer mobile |
| `radius.pill` | `999 px` | badges de estado |
| `shadow.card` | `0 8px 30px rgba(0,0,0,.22)` | card elevado |
| `shadow.popover` | `0 18px 60px rgba(0,0,0,.42)` | popover e drawer |
| `focus.ring` | `0 0 0 3px rgba(56,214,199,.35)` | foco por teclado |

Cards normais usam uma borda de 1 px e não dependem de sombra. Sombras aparecem apenas em elementos elevados. Gradiente é permitido somente como reforço sutil no card de patrimônio e no medidor do limite; nunca atrás de texto longo.

## 8. Componentes base

### 8.1 Estrutura

- **AppShell:** navegação persistente, cabeçalho com período global e conteúdo. Não inclui avatar, perfil ou logout do aplicativo, pois não há autenticação própria.
- **PageHeader:** título, subtítulo opcional, recorte temporal e carimbo de atualização. O recorte é seleção entre opções fornecidas; não é campo livre.
- **SectionGrid:** organiza cards com spans declarativos e mantém ordem semântica no mobile.
- **DetailDrawer:** abre evidências e transações que explicam um indicador sem transformar a experiência numa lista de extrato.

### 8.2 Informação

- **MetricCard:** rótulo, valor, unidade, delta, período, estado e link “Ver composição”. Nunca recebe transações cruas para calcular o valor.
- **ChartCard:** título, descrição curta, legenda, gráfico, estado e resumo textual acessível.
- **StatusBadge:** `healthy`, `pending`, `stale`, `warning`, `critical`, `unavailable`; sempre combina cor, ícone e texto.
- **DataFreshness:** “Atualizado há …”, fonte e horário absoluto no tooltip.
- **InsightCallout:** uma frase determinística ou narrativa de IA marcada como tal, com métricas citadas.
- **EvidenceList:** lista compacta de itens que compõem alerta, recorrência, duplicidade ou anomalia.
- **EmptyState:** explica por que não há dados e qual evento automático pode preencher a área. Nunca sugere cadastrar algo manualmente.

### 8.3 Visualização financeira

- **CurrencyValue:** símbolo, sinal, valor tabular e moeda; não abrevia centavos em valor principal.
- **DeltaValue:** valor absoluto e percentual; quando a base é zero, mostra “sem base de comparação”.
- **LimitGauge:** arco ou barra horizontal com faixas `<70%`, `70–84,99%`, `85–94,99%` e `≥95%`; o estado crítico usa texto “limite crítico”.
- **ProgressBar:** mostra realizado, provisório e referência em segmentos visualmente distintos.
- **Sparkline:** complemento, nunca única representação da tendência.
- **Heatmap:** células com valor no foco/tooltip, legenda e resumo tabular acessível.
- **TimelineChart:** realizado em linha sólida, projeção tracejada e lacunas reais quando não existe snapshot.
- **CategoryBar:** barras ordenadas, rótulo traduzido e drill-down; pizza não é usada quando houver mais de cinco categorias.
- **BillTimeline:** fechamento, hoje e vencimento em uma linha temporal, com countdown textual.
- **LayerSentinel:** visual 2D/3D progressivo do patrimônio observável; cada anel corresponde a um componente real e abre a mesma composição do card.
- **PulseConduit:** sobreposição direcional para fluxo/sync/anomalia; a amplitude deriva de estado fechado da API e não inventa volume.
- **DeterministicCelebration:** sequência curta para marco de economia/streak já confirmado; toca uma vez por `metricId` + limiar e não possui aleatoriedade ou recompensa.

### 8.4 Controles permitidos

- **PeriodSegmentedControl:** opções predefinidas, como mês atual, 3, 6 e 12 meses.
- **CategoryOverrideSelect:** abre com sugestão pré-selecionada e taxonomia oficial; oferece somente `MERCHANT_CNPJ`/`DESCRIPTION_RAW_NORMALIZED`, preserva o `If-Match` e chama a mutação canônica de categoria.
- **InternalTransferChoice:** mostra decisão automática, evidência e três opções: interna, externa ou voltar ao automático (`null`); preserva o `If-Match`.
- **ConfirmPopover:** confirma consequências do override sem exigir digitação.
- **AIActionButton:** ação allowlisted de um clique, sem campo livre e sem persistência financeira.

Não criar botão “Adicionar”, campo de valor, formulário de lançamento, editor de orçamento, upload ou importador.

## 9. Gráficos e legibilidade

- Eixos monetários usam moeda e escala consistente; truncamento como `R$ 1,2 mil` é permitido no eixo, mas tooltip mostra valor completo.
- Todo gráfico apresenta período e fuso. Dados diários usam `America/Sao_Paulo`.
- Tooltips permitem teclado e toque, permanecem dentro da viewport e mostram série, data, valor e estado.
- Zero deve ser distinguido de ausente. Ausência interrompe a linha; não ligar pontos através de lacuna.
- Séries com `PENDING` ou projeção são tracejadas e identificadas na legenda.
- Entrada de gráfico dura no máximo 320 ms. Atualização de número não conta do zero; faz transição curta de opacidade para evitar falsa percepção de crescimento. Efeito energético desenha somente o trecho alterado e não sugere crescimento inexistente.
- Dados reduzidos a “Outros” continuam acessíveis no drawer de composição.

## 10. Movimento e microinterações

| Token | Valor | Uso |
|---|---:|---|
| `motion.fast` | `120 ms` | hover, focus e badge |
| `motion.base` | `180 ms` | expansão e troca de estado |
| `motion.slow` | `240 ms` | drawer e reorganização de gráfico |
| `motion.scene` | `480 ms` | entrada de objeto 3D já carregado |
| `motion.celebration` | `900 ms` | marco determinístico, uma vez |
| `motion.ambient` | `2400 ms` | respiração lenta de saúde, apenas quando visível |
| `ease.standard` | `cubic-bezier(.2,.8,.2,1)` | transições normais |
| `ease.exit` | `cubic-bezier(.4,0,1,1)` | saída |

Regras:

- um pulso elétrico representa uma atualização ou achado e termina; não percorre a tela sem evento;
- o campo de proteção pode respirar em loop lento somente no estado saudável, pausa em aba oculta/offscreen e não altera o texto;
- a celebração determinística toca no máximo uma vez por marco e dispositivo; reabrir a tela não simula nova conquista;
- hover inclina objeto no máximo 3° e não desloca controles; toque não depende de hover;
- com `prefers-reduced-motion: reduce`, remover deslocamento, parallax, desenho de linhas, rotação 3D, pulso, contagem e celebração; manter estado instantâneo ou fade de até 80 ms. Skeleton não pulsa nesse modo.

## 11. 3D/WebGL progressivo e orçamento

3D é camada opcional. `LayerSentinel`, `PulseConduit` e `DeterministicCelebration` têm primeiro uma implementação semântica 2D em HTML/SVG/Canvas acessível; o chunk WebGL substitui apenas a superfície visual depois de a tela estar utilizável.

### 11.1 Carregamento e fallback

- import dinâmico após LCP, `requestIdleCallback` e interseção próxima da viewport; nada 3D entra no bundle crítico;
- máximo de um canvas WebGL visível; ao sair da tela, pausar render loop e liberar texturas quando apropriado;
- `prefers-reduced-motion`, `Save-Data`, dispositivo de memória/CPU baixa, bateria reduzida, WebGL ausente ou `contextlost` selecionam fallback 2D automaticamente;
- falha de asset ou shader não afeta métrica, gráfico, foco, navegação ou override;
- nenhuma leitura, tooltip ou clique essencial existe somente no canvas; a árvore acessível aponta para resumo e composição equivalentes.

### 11.2 Budgets de release

| Budget | Mobile intermediário | Desktop |
|---|---:|---:|
| JS crítico comprimido, sem WebGL | ≤220 KB | ≤220 KB |
| chunk 3D comprimido e lazy | ≤180 KB | ≤220 KB |
| texturas 3D simultâneas | ≤4 MB | ≤8 MB |
| triângulos por cena | ≤25 mil | ≤60 mil |
| draw calls por cena | ≤20 | ≤35 |
| device pixel ratio do canvas | ≤1,5 | ≤2 |
| canvas WebGL visível | 1 | 1 |

Metas de runtime no perfil móvel controlado: LCP ≤2,5 s, INP ≤200 ms, CLS ≤0,1, nenhuma long task adicional >50 ms por inicialização 3D e frame principal dentro de 16,7 ms no percentil 95 durante interação. Se o budget falhar, a release usa o fallback 2D; não aumenta limite silenciosamente.

## 12. Direitos, assets e proveniência

Nomes usados como marca/tema, likeness, silhuetas distintivas, figurinos, logos, símbolos, citações, áudio, frames, painéis de mangá, modelos 3D ou outros assets oficiais de Satoru Gojo, Hajime Kashimo, Kinji Hakari ou *Jujutsu Kaisen* **não entram na build, UI ou material público do produto sem licença/autorização escrita aplicável**. A menção nominativa neste plano serve apenas para identificar o briefing de referência e não autoriza branding ou reprodução.

Antes de F6 há um gate binário:

1. licença aprovada e escopo de uso registrado; ou
2. substituição integral pelos três mascotes originais, com revisão de distinção visual e manifesto de proveniência dos assets.

Placeholder, fan art encontrada na web e asset gerado “parecido” não contornam o gate. O repositório público guarda apenas assets com fonte, autoria, licença e uso permitidos registrados. Nesta rodada não há asset, modelo ou imagem: somente direção de planejamento.

## 13. Estados obrigatórios

Todo card e tela deve implementar:

1. **carregando:** skeleton com dimensões finais, sem spinner que mova layout;
2. **pronto:** valor, período e freshness;
3. **vazio esperado:** mensagem específica, por exemplo “Nenhuma fatura retornada pela instituição”;
4. **dados insuficientes:** informa mínimo necessário e o que já existe;
5. **stale:** mantém último valor válido, adiciona aviso e horário;
6. **erro parcial:** falha de um contrato não derruba os demais widgets;
7. **indisponível:** não usa zero como fallback;
8. **provisório:** identifica impacto de transações `PENDING`.

A prioridade visual de alertas é: fatura vencida ou falha crítica de sync; limite crítico; possível duplicidade/anomalia; atenção; informação. Apenas um alerta crítico ocupa destaque principal por vez; os demais ficam numa pilha ordenada.

## 14. Acessibilidade

- Texto normal deve atingir contraste mínimo 4,5:1; texto grande e elementos gráficos essenciais, 3:1.
- Foco é sempre visível e segue a ordem visual; drawer devolve foco ao acionador ao fechar.
- Ícones decorativos não recebem nome acessível; ícones funcionais têm rótulo.
- Gráficos têm resumo textual, tabela ou lista equivalente; leitor de tela não depende do canvas.
- Verde/vermelho nunca são a única diferença entre entrada e saída ou melhora e piora.
- Zoom de 200% não causa sobreposição nem perda de controles.
- Locale padrão é `pt-BR`; moeda e datas não são transmitidas apenas por posição ou cor.
- Canvas 3D é `aria-hidden` quando decorativo; quando reforça estado, o mesmo estado existe em texto/DOM e o canvas continua fora da ordem de foco.
- Efeitos elétricos não usam flashes acima de três por segundo nem grandes alternâncias de luminância; nenhum efeito pode disparar risco fotossensível.

## 15. Critérios de aceite do design system

- Nenhuma rota renderiza fundo claro nem oferece toggle de tema.
- Uma varredura encontra zero valor de cor ou espaçamento fora dos tokens, exceto em assets aprovados.
- Os breakpoints de 360, 768 e 1440 px não têm overflow horizontal no conteúdo principal.
- Todos os controles são operáveis por teclado e têm alvo mínimo de 44 × 44 px.
- Limite crítico, transação provisória, projeção, transferência interna, dado stale e erro são distinguíveis em escala de cinza por texto, forma ou padrão.
- Cada gráfico possui alternativa textual e tooltip por teclado/toque.
- Cada card implementa os estados carregando, vazio, dados insuficientes, stale, erro e indisponível aplicáveis.
- Nenhum componente calcula métricas financeiras; recebe valores e séries prontos da API interna.
- Só existem componentes de escrita para override de categoria e de transferência interna.
- Desligar WebGL conserva 100% das métricas, evidências e ações; fallback 2D foi comparado em 360, 768 e 1440 px.
- Budgets de bundle, GPU e Core Web Vitals foram medidos no perfil definido; falha força fallback 2D.
- `prefers-reduced-motion`, `Save-Data`, aba oculta e `contextlost` têm testes funcionais.
- Celebração é determinística, sem aposta/loot box, e não toca duas vezes para o mesmo marco.
- Build, UI e material público do produto contêm zero nome usado como tema, likeness ou asset oficial sem licença; alternativa original tem proveniência revisada.

## Pendências / a confirmar

- Escolher entre licença formal para referências de *Jujutsu Kaisen* ou mascotes originais antes de qualquer asset público; sem decisão, usar apenas os equivalentes originais.
- Definir no benchmark da F4 quais dispositivos entram no perfil móvel intermediário e confirmar os budgets 3D sem aumentar o bundle crítico.
