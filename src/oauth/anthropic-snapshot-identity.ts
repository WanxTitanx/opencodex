/** Haly: the Claude Code identity an Anthropic access snapshot signs requests with. */
import type { AnthropicOAuthMetadata, OAuthCredentials } from "./types";

const PROVIDER_ACCOUNT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `metadata.user_id.account_uuid` must name the serving account's real provider UUID: the
 * bearer-verified identity wins, then the stored Claude Code metadata, then a UUID-shaped
 * provider account id. Only when none is known does the adapter fall back to its derived
 * per-slot placeholder. Every snapshot builder (active account and pool selection) uses this,
 * so a pool rotation never signs with another account's — or an invented — identity.
 */
export function anthropicSnapshotIdentity(
  cred: Pick<OAuthCredentials, "accountId" | "anthropic" | "anthropicIdentity">,
): { anthropic?: AnthropicOAuthMetadata } {
  const providerUuid = cred.accountId && PROVIDER_ACCOUNT_UUID.test(cred.accountId) ? cred.accountId : undefined;
  const accountUuid = cred.anthropicIdentity?.accountUuid ?? cred.anthropic?.accountUuid ?? providerUuid;
  if (!cred.anthropic && !accountUuid) return {};
  return { anthropic: { ...cred.anthropic, ...(accountUuid ? { accountUuid } : {}) } };
}
