/**
 * Fail-open for the Headroom hop at send time.
 *
 * `applyHeadroomRoute` decides on a cached `/livez` probe, so a sidecar that is up but
 * failing — its own rate limiter, a 5xx from its pipeline, or a refused or reset loopback
 * connection — used to reach the client as a provider error. A send that went through
 * Headroom and failed on Headroom's side is resent once, unchanged, to the provider it was
 * meant for, and the sidecar is skipped for a short cooldown.
 *
 * Provider answers that Headroom relays keep the provider's own headers (`cf-ray`, request
 * ids, rate-limit and Codex usage headers), so they pass through untouched: only an error
 * Headroom produced itself is treated as ours.
 */

import { redactSecretString } from "../lib/redact";

/** How long a failing sidecar is skipped before requests are routed through it again. */
export const HEADROOM_BYPASS_MS = 30_000;

const HEADROOM_BASE_HEADER = "x-headroom-base-url";
const HEADROOM_PATH_HEADER = "x-headroom-original-path";
const REMEMBERED_BASE_LIMIT = 8;

/** Headers only a provider response carries; Headroom's own errors have none of them. */
const PROVIDER_ORIGIN_HEADERS = new Set([
  "cf-ray",
  "request-id",
  "x-request-id",
  "anthropic-request-id",
  "openai-processing-ms",
  "x-amzn-requestid",
]);
const PROVIDER_ORIGIN_PREFIXES = ["x-codex-", "x-ratelimit-", "anthropic-ratelimit-", "openai-"];

const rememberedBases = new Set<string>();
const bypassUntil = new Map<string, number>();

/** Record a base URL requests were routed through, so a send to it can be recognized. */
export function rememberHeadroomBase(baseUrl: string): void {
  if (rememberedBases.has(baseUrl)) return;
  if (rememberedBases.size >= REMEMBERED_BASE_LIMIT) {
    const oldest = rememberedBases.values().next().value;
    if (oldest !== undefined) rememberedBases.delete(oldest);
  }
  rememberedBases.add(baseUrl);
}

/** True while a sidecar that just failed is being skipped. */
export function isHeadroomBypassed(baseUrl: string, now = Date.now()): boolean {
  const until = bypassUntil.get(baseUrl);
  if (until === undefined) return false;
  if (now < until) return true;
  bypassUntil.delete(baseUrl);
  return false;
}

/** When the current bypass ends, for status reports. */
export function headroomBypassedUntil(baseUrl: string, now = Date.now()): number | undefined {
  return isHeadroomBypassed(baseUrl, now) ? bypassUntil.get(baseUrl) : undefined;
}

function bypassHeadroom(baseUrl: string, reason: string, now = Date.now()): void {
  const active = isHeadroomBypassed(baseUrl, now);
  bypassUntil.set(baseUrl, now + HEADROOM_BYPASS_MS);
  if (!active) {
    console.warn(`[opencodex] Headroom at ${baseUrl} failed (${redactSecretString(reason)}); `
      + `sending directly to the provider for ${HEADROOM_BYPASS_MS / 1000}s.`);
  }
}

/**
 * The provider send a Headroom-routed request stands for: the inverse of
 * `headroomRouteForUpstream`. Null when the URL is not under a base this process routed
 * through, or the request does not carry the upstream Headroom was told to forward to.
 */
export function directSendForHeadroom(url: string, headers: Headers): { url: string; headers: Headers; baseUrl: string } | null {
  const upstreamBase = headers.get(HEADROOM_BASE_HEADER);
  if (!upstreamBase) return null;
  let baseUrl: string | undefined;
  for (const base of rememberedBases) {
    if (url.startsWith(`${base}/`) || url.startsWith(`${base}?`)) {
      baseUrl = base;
      break;
    }
  }
  if (!baseUrl) return null;
  const rest = url.slice(baseUrl.length);
  const originalPath = headers.get(HEADROOM_PATH_HEADER);
  let direct: string;
  if (originalPath) {
    const query = rest.indexOf("?");
    direct = `${upstreamBase}${originalPath}${query >= 0 ? rest.slice(query) : ""}`;
  } else {
    direct = `${upstreamBase}${rest}`;
  }
  try {
    const protocol = new URL(direct).protocol;
    if (protocol !== "https:" && protocol !== "http:") return null;
  } catch {
    return null;
  }
  const directHeaders = new Headers(headers);
  directHeaders.delete(HEADROOM_BASE_HEADER);
  directHeaders.delete(HEADROOM_PATH_HEADER);
  return { url: direct, headers: directHeaders, baseUrl };
}

/** An error status Headroom produced itself rather than relayed from the provider. */
export function isHeadroomOwnFailure(response: Response): boolean {
  if (response.status < 400) return false;
  for (const [name] of response.headers) {
    const lower = name.toLowerCase();
    if (PROVIDER_ORIGIN_HEADERS.has(lower)) return false;
    if (PROVIDER_ORIGIN_PREFIXES.some(prefix => lower.startsWith(prefix))) return false;
  }
  return true;
}

function isReplayableBody(body: RequestInit["body"]): boolean {
  return body === undefined || body === null || typeof body === "string"
    || body instanceof ArrayBuffer || ArrayBuffer.isView(body)
    || body instanceof Blob || body instanceof URLSearchParams;
}

type Send = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => Promise<Response>;

/**
 * Send through Headroom, and resend once directly to the provider when Headroom fails on
 * its own side. Anything that is not a Headroom-routed send goes through untouched.
 */
export async function sendWithHeadroomFallback(
  send: Send,
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  // Nothing was ever routed through Headroom in this process: the common case stays one call.
  if (rememberedBases.size === 0 || (typeof input !== "string" && !(input instanceof URL))) return send(input, init);
  let direct: ReturnType<typeof directSendForHeadroom>;
  try {
    direct = directSendForHeadroom(String(input), new Headers(init?.headers));
  } catch {
    direct = null;
  }
  if (!direct || !isReplayableBody(init?.body)) return send(input, init);
  const directInit: RequestInit = { ...init, headers: direct.headers };
  if (isHeadroomBypassed(direct.baseUrl)) return send(direct.url, directInit);
  let reason: string;
  try {
    const response = await send(input, init);
    if (!isHeadroomOwnFailure(response)) return response;
    reason = `HTTP ${response.status}`;
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    // The caller's own cancellation or header deadline is not a Headroom failure.
    if (init?.signal?.aborted) throw error;
    reason = error instanceof Error ? error.message : String(error);
  }
  bypassHeadroom(direct.baseUrl, reason);
  return send(direct.url, directInit);
}

/** Test seam: forget remembered bases and any active bypass. */
export function resetHeadroomFallbackForTests(): void {
  rememberedBases.clear();
  bypassUntil.clear();
}
