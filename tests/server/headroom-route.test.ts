import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { AdapterRequest } from "../../src/adapters/base";
import type { OcxConfig } from "../../src/types";
import {
  applyHeadroomRoute,
  headroomRouteForUpstream,
  headroomSavingsReport,
  HEADROOM_DEFAULT_BASE_URL,
  resetHeadroomProbeForTests,
  setHeadroomSavingsRunnerForTests,
} from "../../src/headroom";
import {
  directSendForHeadroom,
  isHeadroomBypassed,
  rememberHeadroomBase,
  sendWithHeadroomFallback,
} from "../../src/headroom/fallback";
import { fetchWithHeaderTimeout, providerFetch } from "../../src/server/responses/fetch-helpers";

const HEADROOM = "http://127.0.0.1:8787";

function req(url: string): AdapterRequest {
  return { url, method: "POST", headers: { authorization: "Bearer x" }, body: "{}" };
}

const cfg = (headroom?: OcxConfig["headroom"]) => ({ headroom }) as Pick<OcxConfig, "headroom">;

describe("headroomRouteForUpstream", () => {
  test("maps codex backend paths natively, preserving the path", () => {
    const r = headroomRouteForUpstream("https://chatgpt.com/backend-api/codex/responses", HEADROOM);
    expect(r).toEqual({
      url: `${HEADROOM}/backend-api/codex/responses`,
      upstreamBaseUrl: "https://chatgpt.com",
    });
  });

  test("maps responses/chat-completions via base-url + original-path headers", () => {
    const r1 = headroomRouteForUpstream("https://api.openai.com/v1/responses?x=1", HEADROOM);
    expect(r1?.url).toBe(`${HEADROOM}/v1/responses?x=1`);
    expect(r1?.upstreamBaseUrl).toBe("https://api.openai.com");
    expect(r1?.originalPath).toBe("/v1/responses");

    const r2 = headroomRouteForUpstream("https://x.ai/v1/chat/completions", HEADROOM);
    expect(r2?.url).toBe(`${HEADROOM}/v1/chat/completions`);
    expect(r2?.upstreamBaseUrl).toBe("https://x.ai");
    expect(r2?.originalPath).toBe("/v1/chat/completions");
  });

  test("maps anthropic messages keeping any gateway prefix in the base url", () => {
    const r = headroomRouteForUpstream("https://api.anthropic.com/v1/messages", HEADROOM);
    expect(r?.url).toBe(`${HEADROOM}/v1/messages`);
    expect(r?.upstreamBaseUrl).toBe("https://api.anthropic.com");

    const gw = headroomRouteForUpstream("https://gw.example/anthropic/v1/messages", HEADROOM);
    expect(gw?.upstreamBaseUrl).toBe("https://gw.example/anthropic");
  });

  test("maps gemini generateContent at its native path", () => {
    const r = headroomRouteForUpstream(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      HEADROOM,
    );
    expect(r?.url).toBe(`${HEADROOM}/v1beta/models/gemini-2.5-pro:generateContent`);
    expect(r?.upstreamBaseUrl).toBe("https://generativelanguage.googleapis.com");
  });

  test("returns null for endpoints headroom cannot compress", () => {
    expect(headroomRouteForUpstream("https://api.openai.com/v1/models", HEADROOM)).toBeNull();
    expect(headroomRouteForUpstream("https://api.openai.com/v1/images/generations", HEADROOM)).toBeNull();
  });

  test("returns null for private upstreams headroom's SSRF guard would reject", () => {
    expect(headroomRouteForUpstream("http://127.0.0.1:11434/v1/chat/completions", HEADROOM)).toBeNull();
    expect(headroomRouteForUpstream("http://localhost:8080/v1/responses", HEADROOM)).toBeNull();
    expect(headroomRouteForUpstream("http://192.168.1.5/v1/chat/completions", HEADROOM)).toBeNull();
  });

  test("returns null for non-http(s) and unparseable urls", () => {
    expect(headroomRouteForUpstream("wss://chatgpt.com/backend-api/codex/responses", HEADROOM)).toBeNull();
    expect(headroomRouteForUpstream("not a url", HEADROOM)).toBeNull();
  });

  test("codex-shaped path on a non-chatgpt origin still routes via the responses handler", () => {
    const r = headroomRouteForUpstream("https://codex-shim.example/backend-api/codex/responses", HEADROOM);
    expect(r?.url).toBe(`${HEADROOM}/v1/responses`);
    expect(r?.upstreamBaseUrl).toBe("https://codex-shim.example");
    expect(r?.originalPath).toBe("/backend-api/codex/responses");
  });
});

describe("applyHeadroomRoute", () => {
  let server: Server | undefined;

  beforeEach(() => resetHeadroomProbeForTests());
  afterEach(() => { server?.stop(true); server = undefined; resetHeadroomProbeForTests(); });

  const serve = (ok = true) => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: r => new Response(ok ? "ok" : "no", { status: ok ? 200 : 503 }),
    });
    return `http://127.0.0.1:${server.port}`;
  };

  test("leaves the request untouched when disabled", async () => {
    const base = serve();
    const r = req("https://api.openai.com/v1/responses");
    expect(await applyHeadroomRoute(r, cfg({ enabled: false, baseUrl: base }))).toBe(false);
    expect(r.url).toBe("https://api.openai.com/v1/responses");
    expect(r.headers["x-headroom-base-url"]).toBeUndefined();
  });

  test("leaves the request untouched when headroom is unreachable", async () => {
    // port 1 is never listening — fail-open must keep the provider URL.
    const r = req("https://api.openai.com/v1/responses");
    expect(await applyHeadroomRoute(r, cfg({ enabled: true, baseUrl: "http://127.0.0.1:1" }))).toBe(false);
    expect(r.url).toBe("https://api.openai.com/v1/responses");
  });

  test("rewrites url and injects upstream headers when reachable", async () => {
    const base = serve();
    const r = req("https://api.openai.com/v1/responses");
    expect(await applyHeadroomRoute(r, cfg({ enabled: true, baseUrl: base }))).toBe(true);
    expect(r.url).toBe(`${base}/v1/responses`);
    expect(r.headers["x-headroom-base-url"]).toBe("https://api.openai.com");
    expect(r.headers["x-headroom-original-path"]).toBe("/v1/responses");
    expect(r.headers.authorization).toBe("Bearer x");
  });

  test("skips uncompressible paths even when reachable", async () => {
    const base = serve();
    const r = req("https://api.openai.com/v1/models");
    expect(await applyHeadroomRoute(r, cfg({ enabled: true, baseUrl: base }))).toBe(false);
    expect(r.url).toBe("https://api.openai.com/v1/models");
  });

  test("defaults to the loopback base url", () => {
    const resolved = headroomRouteForUpstream("https://api.openai.com/v1/responses", HEADROOM_DEFAULT_BASE_URL);
    expect(resolved?.url).toBe(`${HEADROOM_DEFAULT_BASE_URL}/v1/responses`);
  });
});

describe("headroomSavingsReport", () => {
  afterEach(() => setHeadroomSavingsRunnerForTests(undefined));

  test("forwards the parsed CLI report and caches it inside the TTL", async () => {
    let calls = 0;
    setHeadroomSavingsRunnerForTests(async () => {
      calls += 1;
      return { lifetime: { tokens_saved: 42 } };
    });
    expect(await headroomSavingsReport()).toEqual({ lifetime: { tokens_saved: 42 } });
    expect(await headroomSavingsReport()).toEqual({ lifetime: { tokens_saved: 42 } });
    expect(calls).toBe(1);
  });

  test("a missing CLI or a failed run surfaces as undefined, never a throw", async () => {
    setHeadroomSavingsRunnerForTests(async () => undefined);
    expect(await headroomSavingsReport()).toBeUndefined();
  });

  test("aggregates the real ledger with the CLI's windows and groupings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-headroom-savings-"));
    const path = join(dir, "savings_events.jsonl");
    const iso = (ms: number) => new Date(ms).toISOString();
    const now = Date.now();
    writeFileSync(path, [
      JSON.stringify({ v: 1, ts: iso(now - 600), before: 100, after: 60, saved: 40, cost_usd: 0.4, model: "m-a", client: "codex" }),
      JSON.stringify({ v: 1, ts: iso(now - 120), before: 60, after: 50, saved: 10, cost_usd: 0.1, model: "m-b", client: "proxy" }),
      // Outside the 30-day retention window — must be pruned on read like the CLI.
      JSON.stringify({ v: 1, ts: iso(now - 31 * 24 * 3600_000), before: 999, after: 1, saved: 998, cost_usd: 9.99, model: "old", client: "codex" }),
      "not json",
      "",
    ].join("\n"));
    const prev = process.env.HEADROOM_SAVINGS_EVENTS_PATH;
    process.env.HEADROOM_SAVINGS_EVENTS_PATH = path;
    try {
      setHeadroomSavingsRunnerForTests(undefined);
      const report = await headroomSavingsReport() as {
        lifetime: { tokens_saved: number; calls: number; savings_percent: number };
        windows: { today: { calls: number }; last_7_days: { calls: number }; last_30_days: { calls: number } };
        by_model: Array<{ model: string }>;
        top_model: string;
      };
      expect(report.lifetime.calls).toBe(2);
      expect(report.lifetime.tokens_saved).toBe(50);
      expect(report.lifetime.savings_percent).toBeCloseTo(31.3, 1);
      expect(report.windows.today.calls).toBe(2);
      expect(report.windows.last_7_days.calls).toBe(2);
      expect(report.windows.last_30_days.calls).toBe(2);
      expect(report.top_model).toBe("m-a");
      expect(report.by_model.map(m => m.model)).toEqual(["m-a", "m-b"]);
    } finally {
      if (prev === undefined) delete process.env.HEADROOM_SAVINGS_EVENTS_PATH;
      else process.env.HEADROOM_SAVINGS_EVENTS_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Headroom send fallback", () => {
  const BASE = "http://127.0.0.1:10010";
  let server: Server | undefined;

  beforeEach(() => { resetHeadroomProbeForTests(); rememberHeadroomBase(BASE); });
  afterEach(() => { server?.stop(true); server = undefined; resetHeadroomProbeForTests(); });

  type Seen = { url: string; headers: Headers; body: unknown };
  const sender = (answer: (url: string) => Response | Promise<Response>) => {
    const seen: Seen[] = [];
    const send = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init?.headers), body: init?.body });
      return answer(url);
    };
    return { seen, send };
  };
  const viaHeadroom = (extra: Record<string, string> = {}): RequestInit => ({
    method: "POST",
    headers: { authorization: "Bearer t", "x-headroom-base-url": "https://chatgpt.com", ...extra },
    body: "{\"input\":[]}",
  });
  const providerOk = () => new Response("data: ok\n\n", { status: 200, headers: { "cf-ray": "abc-GRU" } });

  test("rebuilds the provider URL for every route shape", () => {
    const cases = [
      "https://chatgpt.com/backend-api/codex/responses",
      "https://chatgpt.com/backend-api/codex/responses?stream=1",
      "https://api.openai.com/v1/responses?x=1",
      "https://x.ai/v1/chat/completions",
      "https://host.example/api/v1/chat/completions",
      "https://api.anthropic.com/v1/messages",
      "https://gw.example/anthropic/v1/messages?beta=true",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      "https://gw.example/backend-api/codex/responses",
    ];
    for (const upstream of cases) {
      const route = headroomRouteForUpstream(upstream, BASE)!;
      const headers = new Headers({ authorization: "Bearer t", "x-headroom-base-url": route.upstreamBaseUrl });
      if (route.originalPath) headers.set("x-headroom-original-path", route.originalPath);
      const direct = directSendForHeadroom(route.url, headers);
      expect(direct?.url).toBe(upstream);
      expect(direct?.headers.get("x-headroom-base-url")).toBeNull();
      expect(direct?.headers.get("x-headroom-original-path")).toBeNull();
      expect(direct?.headers.get("authorization")).toBe("Bearer t");
    }
  });

  test("leaves sends that did not go through Headroom alone", async () => {
    const { seen, send } = sender(() => new Response("no", { status: 503 }));
    const response = await sendWithHeadroomFallback(send, "https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    expect(seen.map(s => s.url)).toEqual(["https://chatgpt.com/backend-api/codex/responses"]);
    // A base URL nobody routed through is not Headroom either.
    const other = sender(() => new Response("no", { status: 503 }));
    await sendWithHeadroomFallback(other.send, "http://127.0.0.1:9999/backend-api/codex/responses", viaHeadroom());
    expect(other.seen).toHaveLength(1);
  });

  test("passes a Headroom success through untouched", async () => {
    const { seen, send } = sender(providerOk);
    const response = await sendWithHeadroomFallback(send, `${BASE}/backend-api/codex/responses`, viaHeadroom());
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(isHeadroomBypassed(BASE)).toBe(false);
  });

  test("resends directly when Headroom answers an error of its own, then skips it", async () => {
    const { seen, send } = sender(url => url.startsWith(BASE) ? new Response("Service Unavailable", { status: 503 }) : providerOk());
    const response = await sendWithHeadroomFallback(send, `${BASE}/backend-api/codex/responses`, viaHeadroom());
    expect(response.status).toBe(200);
    expect(seen.map(s => s.url)).toEqual([`${BASE}/backend-api/codex/responses`, "https://chatgpt.com/backend-api/codex/responses"]);
    expect(seen[1]!.body).toBe("{\"input\":[]}");
    expect(seen[1]!.headers.get("x-headroom-base-url")).toBeNull();
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer t");
    expect(isHeadroomBypassed(BASE)).toBe(true);

    // While bypassed, the next send skips Headroom entirely.
    const next = sender(providerOk);
    await sendWithHeadroomFallback(next.send, `${BASE}/backend-api/codex/responses`, viaHeadroom());
    expect(next.seen.map(s => s.url)).toEqual(["https://chatgpt.com/backend-api/codex/responses"]);
  });

  test("treats Headroom's own rate limit and 502 as ours", async () => {
    for (const status of [429, 500, 502, 504]) {
      resetHeadroomProbeForTests();
      rememberHeadroomBase(BASE);
      const { seen, send } = sender(url => url.startsWith(BASE) ? Response.json({ detail: "Rate limited. Retry after 1.0s" }, { status }) : providerOk());
      const response = await sendWithHeadroomFallback(send, `${BASE}/backend-api/codex/responses`, viaHeadroom());
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(2);
    }
  });

  test("relays provider errors that came through Headroom unchanged", async () => {
    for (const headers of [{ "cf-ray": "abc-GRU" }, { "request-id": "req_1" }, { "x-codex-primary-used-percent": "100" }]) {
      resetHeadroomProbeForTests();
      rememberHeadroomBase(BASE);
      const { seen, send } = sender(() => new Response("{\"error\":\"rate_limited\"}", { status: 429, headers }));
      const response = await sendWithHeadroomFallback(send, `${BASE}/backend-api/codex/responses`, viaHeadroom());
      expect(response.status).toBe(429);
      expect(seen).toHaveLength(1);
      expect(isHeadroomBypassed(BASE)).toBe(false);
    }
  });

  test("resends directly when the connection to Headroom fails", async () => {
    const { seen, send } = sender(url => {
      if (url.startsWith(BASE)) throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
      return providerOk();
    });
    const response = await sendWithHeadroomFallback(send, `${BASE}/v1/messages?beta=true`, viaHeadroom({ "x-headroom-base-url": "https://api.anthropic.com" }));
    expect(response.status).toBe(200);
    expect(seen.map(s => s.url)).toEqual([`${BASE}/v1/messages?beta=true`, "https://api.anthropic.com/v1/messages?beta=true"]);
  });

  test("never resends after the caller aborted", async () => {
    const controller = new AbortController();
    const { seen, send } = sender(() => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
    await expect(sendWithHeadroomFallback(send, `${BASE}/backend-api/codex/responses`, { ...viaHeadroom(), signal: controller.signal }))
      .rejects.toThrow("aborted");
    expect(seen).toHaveLength(1);
    expect(isHeadroomBypassed(BASE)).toBe(false);
  });

  test("does not resend a body it cannot replay", async () => {
    const { seen, send } = sender(() => new Response("no", { status: 503 }));
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{}")); c.close(); } });
    const response = await sendWithHeadroomFallback(send, `${BASE}/backend-api/codex/responses`, { ...viaHeadroom(), body });
    expect(response.status).toBe(503);
    expect(seen).toHaveLength(1);
  });

  test("applyHeadroomRoute stops routing while Headroom is bypassed", async () => {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const base = `http://127.0.0.1:${server.port}`;
    const first = req("https://chatgpt.com/backend-api/codex/responses");
    expect(await applyHeadroomRoute(first, cfg({ enabled: true, baseUrl: base }))).toBe(true);
    const { send } = sender(url => url.startsWith(base) ? new Response("no", { status: 503 }) : providerOk());
    await sendWithHeadroomFallback(send, first.url, { method: "POST", headers: first.headers, body: first.body });
    expect(isHeadroomBypassed(base)).toBe(true);
    const second = req("https://chatgpt.com/backend-api/codex/responses");
    expect(await applyHeadroomRoute(second, cfg({ enabled: true, baseUrl: base }))).toBe(false);
    expect(second.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  test("the provider fetch boundary falls back without repeating its dispatch guard", async () => {
    let guards = 0;
    const { seen, send } = sender(url => url.startsWith(BASE) ? new Response("no", { status: 503 }) : providerOk());
    const fetcher = providerFetch({ adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", fetch: send } as OcxProviderConfig & { fetch: typeof fetch }, undefined, {
      httpOnly: true,
      beforeDispatch: () => { guards += 1; },
    });
    const response = await fetchWithHeaderTimeout(`${BASE}/backend-api/codex/responses`, viaHeadroom(), new AbortController().signal, 5_000, true, fetcher);
    expect(response.status).toBe(200);
    expect(seen.map(s => s.url)).toEqual([`${BASE}/backend-api/codex/responses`, "https://chatgpt.com/backend-api/codex/responses"]);
    expect(guards).toBe(1);
  });
});
