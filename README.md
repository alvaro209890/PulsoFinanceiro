# PulsoFinanceiro

Painel financeiro pessoal, automático e self-hosted para transformar os dados já sincronizados pela Pluggy em visão consolidada, alertas e explicações acionáveis. O produto tem um único usuário, não possui cadastro nem autenticação própria e não recebe lançamentos manuais.

> Estado: **Rodada 1 concluída somente como planejamento**. Este repositório contém documentação; não contém aplicação, banco, migrations, serviços ou deploy executável.

## Nome

Foram considerados:

- **PulsoFinanceiro** — escolhido: comunica acompanhamento contínuo, saúde do sistema e alertas sem sugerir digitação manual.
- **NexoFinanceiro** — bom para integração, mas menos direto sobre monitoramento.
- **PrismaFinanceiro** — comunica análise por ângulos, mas é menos específico sobre atualização contínua.

## Resultado pretendido

- Consolidar conta corrente, poupança, cartão e faturas.
- Sincronizar automaticamente sem pedir atualização manual do item da Pluggy.
- Usar webhook como sinal primário e reconciliação agendada como rede de segurança.
- Calcular métricas no backend e servir exatamente os mesmos números ao painel e, futuramente, ao Hermes.
- Manter PII e segredos fora do frontend, dos prompts de IA, dos logs e do Git.
- Permitir somente duas correções de dados em um clique: categoria e transferência interna.
- Entregar um frontend dark-only, muito animado e com 3D progressivo, usando arquétipos originais de leitura/proteção, pulso elétrico e conquista determinística para tornar organização e economia mais claras.
- Planejar uma fase futura em que o Hermes pergunta em Discord privado sobre transação sem contexto e reaplica a resposta segura em repetições, sem acoplar canal ao backend.

## Stack proposta

| Camada | Escolha de planejamento |
|---|---|
| Runtime | Node.js 22 + TypeScript em modo estrito |
| Backend | Fastify, validação de contratos e serviço único para API, SPA e webhook |
| Frontend | React + Vite + TypeScript |
| Dados remotos | Pluggy API, sempre chamada pelo backend |
| Banco | SQLite com WAL, `foreign_keys=ON`, UPSERT e JSON1 |
| Gráficos | Apache ECharts com tema próprio |
| Estado remoto no frontend | TanStack Query; nenhuma métrica financeira calculada no componente |
| IA | OpenRouter, com contexto agregado e sanitizado |
| Exposição | bind em `127.0.0.1:3040`; Cloudflare Tunnel + Access recomendados, com decisão de borda pendente |
| Operação | unidades `systemd --user`; sem Docker e sem Postgres |

As dependências e versões exatas serão travadas na rodada de implementação após validação de compatibilidade com o Node instalado.

## Estrutura desta rodada

```text
PulsoFinanceiro/
├── README.md
├── .gitignore
└── docs/
    ├── 01-visao-e-escopo.md
    ├── 02-arquitetura.md
    ├── 03-infra-e-deploy.md
    ├── 04-integracao-pluggy.md
    ├── 05-modelo-de-dados.md
    ├── 06-job-de-sincronizacao.md
    ├── 07-api-interna.md
    ├── 08-design-system.md
    ├── 09-telas-e-features.md
    ├── 10-camada-ia.md
    ├── 11-seguranca-e-segredos.md
    ├── 12-roadmap.md
    ├── 13-decisoes.md
    └── 14-integracao-hermes.md
```

*(rodada 24/08/2026, Hermes-server — acrescentou `15-front-anime-mecanicas.md` e `16-integracoes-discord-hermes.md`; ver "Estrutura atualizada")*

## Como rodar

A preencher na rodada de implementação. Não há comando válido para executar nesta rodada porque ainda não existem código-fonte, dependências, migrations nem unidades de serviço.

O contrato futuro de execução é:

1. validar configuração e permissões sem imprimir valores;
2. aplicar migrations idempotentes no arquivo SQLite fora do repositório;
3. construir backend e frontend;
4. iniciar o serviço em `127.0.0.1:3040`;
5. executar smoke tests locais antes de configurar Tunnel ou Access.

## Segurança em uma frase

O navegador nunca fala com a Pluggy, o backend nunca confia apenas no loopback, o webhook é apenas um sinal autenticado para uma coleta posterior, e nenhuma credencial ou PII deve entrar neste repositório público.

## Documentos de entrada para a implementação

Antes de escrever código, o agente implementador deve ler os 16 documentos em ordem. Em caso de conflito, valem primeiro os comportamentos medidos em 24/08/2026 (incluindo os testes Pluggy da rodada Hermes-server: `dateFrom`/`dateTo` aceitos, ordem decrescente confirmada, webhook ausente), depois os ADRs em `docs/13-decisoes.md` e, por fim, a documentação externa.

## Estrutura atualizada (rodada 24/08/2026)

```text
docs/
├── 15-front-anime-mecanicas.md   # Gojo/Kashimo/Hakari → Sentinela/Condutor/Catalisador:
│                                 #   Domínio em Camadas, Infinito de cobrança, raio por transação,
│                                 #   laço de anomalia, roleta determinística, cofre de fragmentos,
│                                 #   tabela milestone_events, budgets extras
└── 16-integracoes-discord-hermes.md  # auditoria viva da frota (riscos R1–R6) e
                                      # integrações I1–I8 com ordem de implantação
```

## Pendências / a confirmar

- Autorização operacional para implantar a decisão canônica de Cloudflare Access; exposição humana sem identidade foi descartada.
- Validações externas listadas ao final de cada documento antes de qualquer deploy.
