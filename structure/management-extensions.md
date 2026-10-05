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
