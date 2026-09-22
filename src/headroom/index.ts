/**
 * Headroom sidecar integration.
 *
 * When `config.headroom.enabled` is set, compressible upstream requests are
 * redirected to a local Headroom proxy (default `http://127.0.0.1:8787`) instead
 * of the provider origin. Headroom compresses the conversation, forwards to the
 * real upstream named by `x-headroom-base-url` (plus `x-headroom-original-path`
 * for the OpenAI-family handlers), streams the provider response back, and
 * records the token savings itself — credentials keep flowing in the request
 * headers, so the sidecar needs no keys of its own.
 *
 * The redirect is fail-open: a cached `/livez` probe decides whether the sidecar
 * is up, and an unreachable Headroom leaves the request aimed at the provider
 * directly. Endpoint shapes Headroom cannot compress fall through untouched.
 */

import type { AdapterRequest } from "../adapters/base";
import type { OcxConfig } from "../types";

export const HEADROOM_DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const HEADROOM_PROBE_TTL_MS = 15_000;
const HEADROOM_PROBE_TIMEOUT_MS = 750;
const HEADROOM_READ_TIMEOUT_MS = 3_000;

export interface HeadroomResolvedConfig {
  enabled: boolean;
  baseUrl: string;
}

/**
 * Read the operator's Headroom block. A malformed or blank `baseUrl` degrades to
 * the loopback default rather than disabling the feature or throwing — the same
 * `.catch(undefined)` posture the config schema takes for optional blocks.
 */
export function resolveHeadroomConfig(config: Pick<OcxConfig, "headroom">): HeadroomResolvedConfig {
  const block = config.headroom;
  const raw = typeof block?.baseUrl === "string" ? block.baseUrl.trim() : "";
  let baseUrl = HEADROOM_DEFAULT_BASE_URL;
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        baseUrl = parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
      }
    } catch { /* malformed hand edit keeps the default */ }
  }
  return { enabled: block?.enabled === true, baseUrl };
}

/**
 * True when the upstream host is one Headroom's SSRF guard would reject anyway —
 * loopback, RFC1918, link-local, CGNAT, or cloud-metadata — or a local model
 * endpoint where compression buys nothing. Those requests go direct rather than
 * failing against the guard.
 */
function isPrivateUpstreamHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::1"
    || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.startsWith("fe80:") || host.startsWith("fd") || host.startsWith("::ffff:")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 100 && b >= 64 && b <= 127);
}

interface HeadroomRoute {
  /** URL on the Headroom listener this request should be sent to. */
  url: string;
  /** Value for `x-headroom-base-url`: the upstream base Headroom forwards to. */
  upstreamBaseUrl: string;
  /** Value for `x-headroom-original-path` on OpenAI-family handlers. */
  originalPath?: string;
}

/**
 * Map a provider upstream URL onto the Headroom endpoint that compresses it.
 *
 * Headroom exposes dedicated handlers for the three wire families it optimizes —
 * `/v1/responses` + `/v1/chat/completions` (OpenAI), `/v1/messages` (Anthropic),
 * and the Gemini `/v1beta/models/{m}:*` routes — each honoring a per-request
 * upstream override. Paths outside those shapes (model lists, embeddings, file
 * APIs, image uploads) get no compression and stay direct.
 */
export function headroomRouteForUpstream(rawUrl: string, headroomBaseUrl: string): HeadroomRoute | null {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (isPrivateUpstreamHost(target.hostname)) return null;
  const path = target.pathname;
  const search = target.search;

  // ChatGPT Codex backend paths have a native route (including the WS relay);
  // preserving the path lets Headroom apply its codex-aware handling. A codex
  // path against any other origin still needs the explicit base-url header, or
  // the handler would forward the caller's credentials to chatgpt.com.
  if (path.startsWith("/backend-api/")) {
    if (target.origin === "https://chatgpt.com") {
      return { url: `${headroomBaseUrl}${path}${search}`, upstreamBaseUrl: target.origin };
    }
    if (path.endsWith("/responses")) {
      return {
        url: `${headroomBaseUrl}/v1/responses${search}`,
        upstreamBaseUrl: target.origin,
        originalPath: path,
      };
    }
    return null;
  }

  if (path.endsWith("/responses")) {
    return {
      url: `${headroomBaseUrl}/v1/responses${search}`,
      upstreamBaseUrl: target.origin,
      originalPath: path,
    };
  }
  if (path.endsWith("/chat/completions")) {
    return {
      url: `${headroomBaseUrl}/v1/chat/completions${search}`,
      upstreamBaseUrl: target.origin,
      originalPath: path,
    };
  }
  if (path.endsWith("/v1/messages")) {
    // The Anthropic handler re-attaches the request path to the base, so the
    // base keeps any gateway prefix (`https://host/anthropic` + `/v1/messages`).
    const prefix = path.slice(0, -"/v1/messages".length);
    return {
      url: `${headroomBaseUrl}/v1/messages${search}`,
      upstreamBaseUrl: `${target.origin}${prefix}`,
    };
  }
  if (/^\/v1beta\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(path)) {
    return {
      url: `${headroomBaseUrl}${path}${search}`,
      upstreamBaseUrl: target.origin,
    };
  }
  return null;
}

let probeCache: { baseUrl: string; ok: boolean; checkedAt: number } | undefined;
let probeInFlight: Promise<boolean> | undefined;

/** Cached liveness probe — one loopback `/livez` per TTL window at most. */
export async function isHeadroomReachable(baseUrl: string): Promise<boolean> {
  const now = Date.now();
  if (probeCache && probeCache.baseUrl === baseUrl && now - probeCache.checkedAt < HEADROOM_PROBE_TTL_MS) {
    return probeCache.ok;
  }
  if (!probeInFlight) {
    probeInFlight = (async () => {
      try {
        const res = await fetch(`${baseUrl}/livez`, { signal: AbortSignal.timeout(HEADROOM_PROBE_TIMEOUT_MS) });
        return res.ok;
      } catch {
        return false;
      }
    })();
  }
  const ok = await probeInFlight;
  probeInFlight = undefined;
  probeCache = { baseUrl, ok, checkedAt: Date.now() };
  return ok;
}

/** Test seam: drop the cached probe so each case controls its own sidecar state. */
export function resetHeadroomProbeForTests(): void {
  probeCache = undefined;
  probeInFlight = undefined;
}

/**
 * Redirect a serialized upstream request through the local Headroom proxy.
 * Returns true when the request now points at Headroom. Fail-open on every
 * boundary: disabled config, unmappable path, private upstream, and an
 * unreachable sidecar all leave the request untouched.
 */
export async function applyHeadroomRoute(request: AdapterRequest, config: Pick<OcxConfig, "headroom">): Promise<boolean> {
  const headroom = resolveHeadroomConfig(config);
  if (!headroom.enabled) return false;
  const route = headroomRouteForUpstream(request.url, headroom.baseUrl);
  if (!route) return false;
  if (!(await isHeadroomReachable(headroom.baseUrl))) return false;
  request.url = route.url;
  request.headers["x-headroom-base-url"] = route.upstreamBaseUrl;
  if (route.originalPath) request.headers["x-headroom-original-path"] = route.originalPath;
  return true;
}

/**
 * Fetch a Headroom JSON endpoint for the management plane. Returns undefined on
 * any failure — callers surface "unreachable", never a thrown stack.
 */
export async function fetchHeadroomJson(baseUrl: string, path: string): Promise<unknown> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(HEADROOM_READ_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Snapshot for `/api/headroom`: config view plus a fresh liveness probe. */
export async function headroomStatus(config: Pick<OcxConfig, "headroom">): Promise<{
  enabled: boolean;
  baseUrl: string;
  reachable: boolean;
  stats: unknown;
}> {
  const headroom = resolveHeadroomConfig(config);
  // A management read bypasses the probe cache so the toggle reflects now, not
  // the state up to 15s ago.
  let reachable = false;
  try {
    const res = await fetch(`${headroom.baseUrl}/livez`, { signal: AbortSignal.timeout(HEADROOM_READ_TIMEOUT_MS) });
    reachable = res.ok;
    probeCache = { baseUrl: headroom.baseUrl, ok: reachable, checkedAt: Date.now() };
  } catch {
    probeCache = { baseUrl: headroom.baseUrl, ok: false, checkedAt: Date.now() };
  }
  const stats = reachable ? await fetchHeadroomJson(headroom.baseUrl, "/stats") : undefined;
  return { enabled: headroom.enabled, baseUrl: headroom.baseUrl, reachable, stats };
}
