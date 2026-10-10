/**
 * One-time migration of persisted Codex-login sidecar models to native GPT-6 Luna.
 *
 * The stored `gpt-5.4-mini` choice is retired upstream, and `gpt-5.6-luna` is now the
 * previous default. Both move to `gpt-6-luna` for web-search, vision and pool warmup.
 *
 * The match is exact equality, so explicitly saved legacy choices are migrated too.
 * Any other model value is left alone.
 */
import type { OcxConfig } from "../types";

/** July 9 21:00 UTC = KST July 10 06:00. */
export const RETIRED_MODEL_MIGRATION_CUTOFF = Date.UTC(2026, 6, 9, 21, 0);

const LEGACY_SIDECAR_MODELS = new Set(["gpt-5.4-mini", "gpt-5.6-luna"]);
const REPLACEMENT_MODEL = "gpt-6-luna";

/**
 * @returns true when the config changed and the caller should persist it.
 */
export function runRetiredCodexModelMigration(config: OcxConfig, now = Date.now()): boolean {
  if (now < RETIRED_MODEL_MIGRATION_CUTOFF) return false;
  let migrated = false;
  if (config.webSearchSidecar && LEGACY_SIDECAR_MODELS.has(config.webSearchSidecar.model ?? "")) {
    config.webSearchSidecar = { ...config.webSearchSidecar, model: REPLACEMENT_MODEL };
    migrated = true;
  }
  if (config.visionSidecar && LEGACY_SIDECAR_MODELS.has(config.visionSidecar.model ?? "")) {
    config.visionSidecar = { ...config.visionSidecar, model: REPLACEMENT_MODEL };
    migrated = true;
  }
  if (config.tokenGuardian && LEGACY_SIDECAR_MODELS.has(config.tokenGuardian.codexWarmupModel ?? "")) {
    config.tokenGuardian = { ...config.tokenGuardian, codexWarmupModel: REPLACEMENT_MODEL };
    migrated = true;
  }
  return migrated;
}
