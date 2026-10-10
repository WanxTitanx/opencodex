# Management extensions

`src/headroom/index.ts` owns the optional compression sidecar client and its durable savings ledger.

The Connect group contains a dedicated API keys page (`gui/src/pages/ApiKeysPage.tsx`) and the Usage & Logs group contains the
optional Headroom page (`gui/src/pages/Headroom.tsx`). The workspace quota and model-access
editors live in `gui/src/components/apikeys-workspace/ApiKeyQuotaEditor.tsx` and
`gui/src/components/apikeys-workspace/ApiKeyModelAccessEditor.tsx` alongside upstream key
rotation and API-surface information. Headroom status and its durable savings ledger are
projected through `src/server/management/headroom-routes.ts`; its configuration remains opt-in.

`src/server/management/oauth-account-routes.ts` validates quota and provider/model scope
fields before creating or updating a key. Creation uses the shared durable key issuer;
revocation also forgets the key in the quota ledger. `src/server/api-key-quota.ts` observes
usage and denies a key once its configured rolling spend limit is reached. Unset or zero
limits remain unlimited. `src/server/index/public-model-list.ts` assembles public model
rows, and `src/server/index/scoped-catalog-filter.ts` applies the admitted key's model scope.

`src/cli/headroom.ts` exposes the same status, statistics, and explicit settings mutations through `ocx headroom status`, `stats`, and `config`. Missing quota telemetry in older API-key rows keeps lifecycle actions available and is not rendered as zero spending.

The eight sidebar groups remain owned by `gui/src/nav-groups.ts`. Connect includes the standalone API-key page; Usage & Logs includes Headroom. Legacy API-key hashes resolve to the dedicated page through `gui/src/app-routing.ts`.

## Headroom compression sidecar

Unlike the model-authority sidecars in [service and sidecars](ops/service-and-sidecars.md), `src/headroom/` is not a model authority but a local proxy
(default `http://127.0.0.1:8787`) that compresses the serialized upstream request and
forwards it itself. When `config.headroom.enabled` is set, each built `AdapterRequest`
whose upstream path maps to a Headroom endpoint (`/v1/responses`, `/v1/chat/completions`,
`/v1/messages`, the Gemini `/v1beta/models/*` generate routes, or a native
`/backend-api/*` ChatGPT path) is re-pointed at the sidecar with
`x-headroom-base-url`/`x-headroom-original-path` carrying the real destination, so
credentials flow inside the request and Headroom needs none of its own. A cached
`/livez` probe keeps the redirect fail-open: an unreachable sidecar leaves the request
aimed at the provider origin. Private/loopback upstreams and endpoint shapes Headroom
cannot compress are never redirected. At send time `src/headroom/fallback.ts` wraps the
physical dispatch in `providerFetch`, below the dispatch guard and attempt accounting: a
refused or reset loopback connection, or an error status Headroom produced itself (no
provider headers such as `cf-ray`, request ids or `x-codex-*`), resends the same request
once directly to the provider and skips the sidecar for 30 s; provider errors relayed
through Headroom pass unchanged. `/api/headroom` on the management plane exposes
the toggle, base URL, liveness, any active bypass, the sidecar's own `/stats` metrics, and the durable
savings ledger aggregated from `~/.headroom/savings_events.jsonl` — read in-process
because the `headroom savings` CLI costs seconds per invocation while the dashboard
polls.
