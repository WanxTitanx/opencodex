# Haly build (fork local)

Este branch (`haly-sync`) é o OpenCodex oficial (`lidge-jun/opencodex`) com as extensões do
Haly, o RTK embutido e os patches locais. Ele não é publicado no npm: é empacotado e instalado
localmente. O `package.json` segue a versão do OpenCodex que foi mesclada por último.

## Remotes

| remote | repositório | uso |
| --- | --- | --- |
| `lidge-jun` | `lidge-jun/opencodex` | OpenCodex oficial; mesclar a tag de release (`vX.Y.Z`) |
| `upstream` | `halysondev/opencodex` | origem das extensões Haly (o branch `haly` não existe mais lá) |
| `origin` | `WanxTitanx/opencodex` | fork próprio; backup dos branches de integração |

## O que este branch mantém em cima do OpenCodex

- Sidecar Headroom: compressão de contexto, página no dashboard, `/api/headroom`, ledger de economia e `ocx headroom`.
  Se o Headroom falhar do lado dele (conexão recusada ou resetada, ou 429/5xx gerado por ele, sem `cf-ray`), o envio vai
  direto ao provedor e o Headroom fica de fora por 30 s (`src/headroom/fallback.ts`). O serviço `headroom-proxy` roda com
  `--no-rate-limit --no-http2`: sem o limite padrão de 60 req/min e 100 mil tokens/min, e sem a conexão HTTP/2
  compartilhada com o chatgpt.com, que derrubava várias respostas de uma vez (StreamReset).
- Chaves de API: cotas de gasto (24 h / 7 d / 30 d, reset por chave ou geral) e escopo de modelos.
- Identidade Claude Code no OAuth da Anthropic (paridade com o `dario`): fingerprint de headers, body sintetizado no formato do CC, `metadata.user_id` da conta que serve a requisição, endpoint de token `platform.claude.com` e o conjunto de 6 scopes do login.
- Identidade do Codex no refresh do ChatGPT (`originator`, `User-Agent` e `scope`).
- Cooldown por família de modelo no pool Anthropic (`src/oauth/anthropic-model-cooldown.ts`), só no pool principal.
- RTK embutido (`ocx rtk`), com os binários verificados por hash no empacotamento.
- Sidecars (visão, busca web, warmup) com GPT-6 Luna como padrão e migração dos valores antigos (`gpt-5.4-mini`, `gpt-5.6-luna`).
- Proteção contra atualização: com o marcador `.haly-local-build` na raiz do pacote instalado, `ocx update`, o botão de update do dashboard e o autoupdate recusam instalar o pacote oficial (que apagaria tudo acima). `OCX_ALLOW_UPSTREAM_UPDATE=1` força a troca.

## Divergências conhecidas em relação aos testes do upstream

O caminho sintetizado do OAuth Claude segue a paridade com o CC de propósito. Os testes do upstream
que esperam outro comportamento foram ajustados com comentários `Haly (dario parity)`:

- Sem `tool_choice` no body sintetizado (o CC real não envia), então `parallel_tool_calls: false` não vira `disable_parallel_tool_use`.
- Breakpoints de cache de 5 minutos; `ttl: "1h"` só quando o cliente envia o beta `extended-cache-ttl`.
- Thinking assinado nunca é reenviado no caminho sintetizado; `redacted_thinking` do cliente segue como veio, inclusive depois de troca de pool. Se aparecer 400 de `redacted_thinking` após failover, o ponto é `stripClaudeHistoryArtifacts` em `src/claude/cc-fingerprint.ts`.
- Clientes Messages não-genuínos mantêm os nomes das próprias tools (sem prefixo `custom_`).
- `release-version-line` falha neste fork: a versão é igual à da tag oficial e o commit não é o da tag. É esperado.
- `tests/fixtures/file-size-baseline.json` registra `src/server/responses/adapter-dispatch.ts` e
  `passthrough-dispatch.ts` acima de 2000 linhas: desde a 2.93 o upstream deixa os dois no limite, e os hooks do Haly
  (Headroom e a recuperação de 400 do OAuth Claude) passam do teto. Ao mesclar, atualizar esses dois tetos com o tamanho novo.
- `tests/fixtures/import-cycle-baseline.json` inclui `src/oauth/anthropic-model-cooldown.ts`: o cooldown por família lê a
  cota em cache de `providers/quota`, que já está no ciclo de imports do upstream.
- No caminho OAuth sintetizado, o thinking segue o template do CC: `display: "omitted"`, sem o beta
  `thinking-display-updates` do Opus 5.5 (#7143), e as assinaturas que voltam no `reasoning_details` do Chat (#7469) não
  são reenviadas. A troca de token do login Anthropic, inclusive no modo código (#7170), vai para `platform.claude.com`.
  Os testes do upstream que esperam outra coisa foram ajustados com o mesmo comentário `Haly (dario parity)`.

## Atualizar para uma nova versão do OpenCodex

1. `git fetch lidge-jun --tags` e `git merge vX.Y.Z` no `haly-sync`.
2. Resolver os conflitos mantendo as features acima. Arquivos gerados: `bun run skill:surface`, `bun run structure:index`; conferir `bun scripts/file-size-ratchet.ts`.
3. `bun x tsc --noEmit`, `cd gui && bun x tsc -b && bun run lint`, e os testes das áreas tocadas (`bun run test <arquivos>`; a suíte completa passa de 900 s em máquinas pequenas).
4. Empacotar: `bun install`, `bun run build:gui`, `npm pack` (o `prepack` baixa e verifica o RTK).
5. Instalar em `~/.local/opt/opencodex-haly/<versão>-<commit>/`: copiar o `.tgz`, `package.json` com `"@bitkyc08/opencodex": "file:<tgz>"`, `npm install --omit=dev`, criar `node_modules/@bitkyc08/opencodex/.haly-local-build`.
6. Apontar `~/.local/lib/node_modules/@bitkyc08/opencodex` para `node_modules/@bitkyc08/opencodex` da nova pasta e rodar
   `ocx service restart`. O proxy roda pelo serviço systemd `opencodex-proxy`: o `ocx restart` de um CLI mais novo não troca
   a versão de um proxy supervisionado (falha com `update_restart_eligibility_failed`), e o `ocx service restart` regrava a
   unit a partir da instalação atual antes de reiniciar. Se o `ocx status` mostrar o serviço parado e um proxy avulso
   ocupando a porta ("service installed, not running"), usar `ocx service install`: ele para o serviço e o proxy avulso
   antes de regravar a unit; o `ocx service restart` não para o proxy avulso.

Rollback: apontar o link de volta para a pasta anterior em `~/.local/opt/opencodex-haly/` e `ocx service restart`.
