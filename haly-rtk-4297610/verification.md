# Haly / RTK validation

Source commit: `4297610898ba95a4d2a15d5de952a04867ef22b2`. Integration commit: `2f9367d63e2e82ac8edec297b36ff678c387ea54`.
Stable feature baseline: OpenCodex `v2.73.0` (`569e3e7dae48bafc54b8a1a7e3a85129befe2d98`).
The package follows upstream dev's `2.74.0` version line; this is not a published upstream 2.74 release.
RTK: `0.50.0`, source `1d87b8e719ce0a50c223cd93ca64dd16921f9aec`, Apache-2.0.

## Passed

- TypeScript typecheck, structure SSOT, privacy scan, GUI lint and documentation build.
- GUI: 2,650 tests, zero failures, across 305 files.
- Final targeted gates: 213 tests, zero failures, across 14 files (RTK, CLI, packaging, native resources, layout, structure, GPT-6.1 Sol, and identity).
- Additional identity/routing regression group: 122 tests, zero failures, across four files. These groups overlap; they are not an aggregate count.
- `npm pack`: all five RTK executables are present with executable modes and the exact pinned binary SHA-256 digests; LICENSE and NOTICE are present.
- A real npm installation into an isolated prefix and a real Linux x64 standalone build ran from unrelated directories with a PATH containing Git but no RTK.
- Both distributions reported `opencodex 2.74.0` and `rtk 0.50.0`, loaded the packaged keyring without credential access, filtered a synthetic Git status, preserved literal/spaced arguments, and propagated delegated exit code 17.
- Headroom and API-key detail navigation rendered in a fresh isolated browser. Screenshots use synthetic fixtures. No browser JavaScript errors were observed.

## Limits and baseline controls

`bun run test --dots` reached the canonical 900-second limit. It is not reported as passing.
Four routing failures also reproduced on pristine v2.73.0 in `combo-management-api.test.ts` and `routing-profile-management-editor.test.ts` (49 pass, four fail, two timeout errors).
Additional failed files were rerun individually, with a pristine upstream control when they failed:

| File | Integrated exit | Upstream exit | Observation |
|---|---:|---:|---|
| `tests/claude-integration/claude-desktop-first-party-guards.test.ts` | 1 | 1 | Same failed cases |
| `tests/providers/provider-outbound.test.ts` | 1 | 1 | Same failed cases |
| `tests/claude-integration/claude-picker-runtime.test.ts` | 1 | 1 | Same failed cases |
| `tests/server/management-provider-validation.test.ts` | 124 | 124 | Same failed cases |
| `tests/vision/sidecar-settings-web-search-off.test.ts` | 1 | 1 | Same failed cases |
| `tests/vision/sidecar-settings-web-search-stream.test.ts` | 1 | 1 | Same failed cases |
| `tests/vision/vision-backend-union.test.ts` | 1 | 1 | Same failed cases |
| `tests/web-search/web-search-backend-union.test.ts` | 1 | 1 | Same failed cases |
| `tests/web-search/web-search.test.ts` | 1 | 1 | Same failed cases |
| `tests/config/serving-runtimes.test.ts` | 1 | 1 | Same failed cases |
| `tests/service/crash-guard.test.ts` | 1 | 1 | Same failed cases |
| `tests/service/shutdown-launcher.test.ts` | 124 | 124 | Same failed cases |

The previously failing doctor and CLI-model files passed individually. The one integration-specific client-fingerprint mismatch was corrected to check case-insensitive HTTP headers and the declared Haly/native lane contracts; its final focused run passed.
Controls above are diagnostic evidence collected during integration, not a claim that the entire final-head suite passed.
The isolated direct-start browser fixture also produced an ENOENT from the unchanged upstream response-spill memory diagnostic; the displayed panels remained usable. This is not represented as a clean backend-wide run.

Windows/macOS executable runs, desktop signing/notarization, live provider inference, and independent security/maintainer review remain unverified. Release workflow coverage is authored, not an executed release.
No merge, deployment, public package release, or production installation is part of this PR.
