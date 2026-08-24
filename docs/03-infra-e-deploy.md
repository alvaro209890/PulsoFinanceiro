# 03 — Infraestrutura e deploy

## Estado observado

Inventário somente leitura reconfirmado no `server-desktop` em **24/08/2026 às 10:50 BRT**.

| Item | Evidência observada |
|---|---|
| Produção | `/media/server/HD Backup/Servidores_NAO_MEXA/` |
| HD de produção | 1,9 TB; 681 GB usados; 1,2 TB livres; 37% usado |
| SSD `/` | 109 GB; 76 GB usados; 29 GB livres; 73% usado |
| Node | `v22.23.1` |
| Python | `3.12.3` |
| Docker Compose | `2.40.3` |
| PostgreSQL CLI | `psql 16.15` |
| SQLite CLI | `3.45.1` |
| Cloudflare | `cloudflared.service` ativo; nenhuma alteração realizada |
| OpenRouter | variável `OPENROUTER_API_KEY` presente em `/home/server/.hermes/.env`, arquivo modo `600`; valor não lido |

O texto de entrada dizia haver 22 diretórios preexistentes. A leitura atual encontrou **25 diretórios preexistentes e um arquivo de controle** no primeiro nível, antes da nova pasta. Nada foi corrigido: a divergência fica registrada.

Os containers observados eram três e permaneceram intactos. Os serviços `systemd --user` existentes também foram somente listados.

## Pastas reservadas nesta rodada

| Uso | Caminho | Estado em 24/08/2026 |
|---|---|---|
| documentação e futuro código | `/media/server/HD Backup/Servidores_NAO_MEXA/PulsoFinanceiro/` | criada e inicialmente vazia |
| banco e backups | `/media/server/HD Backup/Servidores_NAO_MEXA/Banco_de_dados/PulsoFinanceiro/` | criada e inicialmente vazia |

Banco futuro:

```text
/media/server/HD Backup/Servidores_NAO_MEXA/Banco_de_dados/PulsoFinanceiro/
├── pulso_financeiro.sqlite
└── backups/
```

O arquivo SQLite, seus sidecars, backups e exports ficam fora do Git.

## Porta

Escolha proposta: **TCP 3040**, com bind obrigatório em `127.0.0.1`.

Evidência: `ss -tlnH` não mostrou listener em 3040 às 10:50 BRT. As portas 3041, 3050, 3051, 5440, 8090 e 9130 também estavam livres; 3040 foi escolhida por proximidade com a faixa web interna sem colidir com 3001–3031.

Esta evidência é um snapshot, não uma reserva do kernel. A rodada de implantação deve repetir o teste imediatamente antes de iniciar o serviço.

## Hostnames

| Hostname proposto | Uso | Controle |
|---|---|---|
| `pulso.cursar.space` | SPA e `/api/v1` humana, somente na decisão Access | Access na borda + JWT integralmente validado no origin |
| `pulso-hooks.cursar.space` | somente `POST /api/webhooks/pluggy`, somente na decisão Access | Bearer, WAF, rate limit e coleta autenticada posterior |

Evidência em 24/08/2026:

- os dois nomes não resolveram em DNS via `getent ahosts`;
- os dois nomes estavam ausentes dos `hostname:` dos YMLs em `/home/server/.cloudflared/`;
- nenhum túnel, DNS ou política Access foi criado nesta rodada.

Separar os hosts impede que uma exceção pública de webhook enfraqueça a aplicação Access que protege o extrato. Se Access se tornar inviável e o fallback Tailscale por proxy autenticador for aprovado, nenhum dos dois hostnames é criado e o produto opera pelo fallback/reconciliação agendados, sem webhook público.

## Cloudflare Tunnel proposto para a decisão Access

Arquivo futuro: `/home/server/.cloudflared/pulso-financeiro.yml`.

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/server/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: pulso.cursar.space
    service: http://127.0.0.1:3040
  - hostname: pulso-hooks.cursar.space
    service: http://127.0.0.1:3040
  - service: http_status:404
```

Regras para a rodada de implantação:

1. criar túnel dedicado ou identificar explicitamente o túnel aprovado;
2. passar `--config /home/server/.cloudflared/pulso-financeiro.yml` em todo comando;
3. usar o **ID** do túnel, não confiar no nome;
4. criar DNS somente depois de validar o YML;
5. validar que o host principal está coberto integralmente por Access e que o origin rejeita JWT ausente/inválido mesmo quando a chamada chega diretamente por loopback;
6. limitar o host de hooks ao path e método previstos;
7. nunca adicionar `noTLSVerify` sem incidente e justificativa específicos.

Comandos de DNS a executar somente após aprovação:

```text
cloudflared tunnel --config /home/server/.cloudflared/pulso-financeiro.yml route dns --overwrite-dns <TUNNEL_ID> pulso.cursar.space
cloudflared tunnel --config /home/server/.cloudflared/pulso-financeiro.yml route dns --overwrite-dns <TUNNEL_ID> pulso-hooks.cursar.space
```

## Serviço principal proposto

Arquivo futuro: `/home/server/.config/systemd/user/pulso-financeiro.service`.

```ini
[Unit]
Description=PulsoFinanceiro
After=network-online.target

[Service]
Type=simple
WorkingDirectory="/media/server/HD Backup/Servidores_NAO_MEXA/PulsoFinanceiro"
EnvironmentFile=/home/server/.config/pulso-financeiro/.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths="/media/server/HD Backup/Servidores_NAO_MEXA/Banco_de_dados/PulsoFinanceiro"

[Install]
WantedBy=default.target
```

O processo deve recusar startup se `HOST` for diferente de `127.0.0.1`, se a pasta do banco for gravável por condição inesperada ou se faltarem variáveis obrigatórias. O sandbox proposto precisa ser testado porque o banco vive em volume montado.

## Unidades de sincronização propostas

| Unidade | Agenda BRT | Ação |
|---|---|---|
| `pulso-financeiro-sync.service` | oneshot | `sync --mode incremental` ou `reconciliation` |
| `pulso-financeiro-sync.timer` | diário, 07:15 | fallback incremental; não força update Pluggy |
| `pulso-financeiro-reconcile.timer` | domingo, 03:40 | reconciliação por cursor |
| `pulso-financeiro-backup.timer` | diário, 03:15 | backup online antes da reconciliação semanal |

Cada timer usa `Persistent=true` para recuperar uma execução perdida após desligamento. Um jitter curto evita concentrar operações no mesmo minuto que outros serviços. A agenda final deve considerar o `nextAutoSyncAt` observado, que é previsão mínima e pode atrasar.

## Configuração futura fora do Git

Arquivo: `/home/server/.config/pulso-financeiro/.env`, modo `600`, dono `server`.

Somente nomes, nunca valores:

```text
NODE_ENV
HOST
PORT
DATABASE_PATH
PLUGGY_CLIENT_ID
PLUGGY_CLIENT_SECRET
PLUGGY_ITEM_ID
PLUGGY_WEBHOOK_BEARER_TOKEN
CLOUDFLARE_ACCESS_AUD
CLOUDFLARE_ACCESS_TEAM_DOMAIN
OPENROUTER_MODEL
OPENROUTER_FALLBACK_MODEL
LOG_LEVEL
```

`OPENROUTER_API_KEY` não é duplicada nesse arquivo. O backend lê exclusivamente essa chave de `/home/server/.hermes/.env` em runtime e descarta as demais entradas; o serviço não importa o arquivo inteiro para o ambiente.

Tokens do Hermes também não pertencem a esse arquivo: cada perfil chamador guarda apenas seu `PULSO_HERMES_API_KEY` bruto no secret store privado do próprio Hermes, enquanto o PulsoFinanceiro conserva somente hashes, escopos e metadados de rotação no registry SQLite `service_principals`.

## Pipeline de implantação futuro

Nenhuma etapa foi executada nesta rodada.

1. **Preflight:** confirmar branch, worktree limpo, commit publicado, Node, porta, espaço, permissões, segredos presentes sem imprimi-los e backup válido.
2. **Dependências:** instalar do lockfile com scripts nativos auditados.
3. **Qualidade:** lint, typecheck, testes unitários, testes de contrato e varredura de segredos.
4. **Banco:** criar backup online; aplicar migrations versionadas numa transação; rodar `foreign_key_check`.
5. **Build:** gerar backend e SPA; registrar o SHA do commit no endpoint de versão.
6. **Smoke local:** validar liveness, readiness, leitura vazia/degradada e bloqueio sem credencial de borda.
7. **Serviço:** instalar/atualizar unidades e reiniciar somente após aprovação da rodada operacional.
8. **Borda:** no caminho Access, configurar Tunnel/Access por último e testar JWT no origin, acesso autorizado/negado, webhook e tentativa direta por loopback; se A tiver impedimento documentado e B for aprovado, testar o proxy autenticador Tailscale e confirmar que não há DNS público. Exposição aberta não é caminho de deploy.
9. **Pós-deploy:** coletar uma conta fictícia/sandbox ou executar dry-run antes de usar dados reais.

## Health checks

| Endpoint | Conteúdo | Exposição |
|---|---|---|
| `GET /health/live` | processo vivo, sem versão sensível nem estado financeiro | pode responder localmente sem identidade |
| `GET /health/ready` | banco abre, migrations corretas e lock não preso | local/systemd; sem dados |
| `GET /api/v1/system/health` | estado do item, datas e contagens permitidas | identidade de borda aprovada obrigatória; Access em A |

Loopback não concede acesso a dados. Somente os dois health checks mínimos podem ser anônimos porque não retornam informação financeira.

## Backup SQLite

Nunca copiar apenas o `.sqlite` enquanto WAL estiver ativo. A unidade de backup deve:

1. criar `backups/pulso_financeiro-<UTC>.sqlite` com a Online Backup API ou comando `.backup` do SQLite;
2. abrir a cópia e exigir `PRAGMA integrity_check = ok`;
3. calcular SHA-256;
4. gravar log sem path de segredo ou conteúdo financeiro;
5. manter 30 diários e 12 fechamentos mensais;
6. apagar excedentes somente depois de confirmar pelo path absoluto que o alvo está dentro de `.../PulsoFinanceiro/backups/`;
7. testar restauração trimestralmente em arquivo temporário, sem sobrescrever produção.

WAL e SHM são runtime, não artefatos de backup. O backup resultante precisa ser autocontido.

## Rollback

### Aplicação

1. identificar o último SHA conhecido e o schema que ele suporta;
2. manter o banco atual e fazer novo backup;
3. reconstruir o SHA anterior;
4. reiniciar apenas o serviço principal;
5. validar readiness e três métricas determinísticas.

### Banco

- Preferir migrations aditivas e compatibilidade reversa.
- Restaurar banco somente se a migration for incompatível e houver aprovação explícita.
- Restaurar para novo arquivo, validar integridade e então trocar `DATABASE_PATH`; nunca sobrescrever a única cópia.
- Reaplicar eventos posteriores apenas por reconciliação autenticada com a Pluggy.

## Evidência de não interferência nesta rodada

Antes da criação, foi calculado o hash SHA-256 das entradas preexistentes em cada diretório pai. Depois da criação das duas pastas, os hashes recalculados excluindo `PulsoFinanceiro` permaneceram iguais:

- projetos preexistentes: `78e15caf2491dd62290d6f381c73094c06741f39128c6b6711161d1a1b133aed`;
- subpastas de bancos preexistentes: `fc1e44252585712c27bc2e9dde699f988f9a693a39d2090d30c932f0475934ea`.

Isto comprova que nenhum diretório irmão foi criado, movido ou removido; o arquivo de controle preexistente foi apenas observado. Não é hash recursivo do conteúdo interno, que foi tratado como intocável.

## Pendências / a confirmar

- O volume mostra modo `777` inclusive nas pastas pai e novas; confirmar se o filesystem/mount honra `chmod 600` para o futuro banco. Se não honrar, definir controle compensatório ou armazenamento cifrado antes de persistir PII.
- Resolver com o usuário a divergência entre “22 diretórios” do briefing e 25 diretórios preexistentes observados.
- Autorizar porta 3040 e unidades propostas; no caminho Access, autorizar também `pulso.cursar.space`, `pulso-hooks.cursar.space` e túnel dedicado. No fallback Tailscale, os hostnames não se aplicam.
- Definir horário final a partir de alguns ciclos reais de `nextAutoSyncAt`.
- Executar toda alteração de serviço, Access, DNS, tunnel, `.env`, migration e backup apenas em rodada futura aprovada.
