import { useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { readJsonOrThrow } from "../fetch-json";
import { formatTokens } from "../format-tokens";
import { IconActivity, IconRefresh } from "../icons";
import { useI18n } from "../i18n/shared";
import { Notice, Switch } from "../ui";

interface HeadroomCompression {
  requests_compressed?: number;
  avg_compression_pct?: number;
  best_compression_pct?: number;
  total_tokens_removed?: number;
  total_tokens_before?: number;
  total_tokens_saved_all_layers?: number;
}
interface HeadroomCost {
  total_saved_usd?: number;
  savings_pct?: number;
  without_headroom_usd?: number;
}
interface HeadroomSummary {
  mode?: string;
  api_requests?: number;
  compression?: HeadroomCompression;
  cost?: HeadroomCost;
}
interface HeadroomStats { summary?: HeadroomSummary }
interface HeadroomState {
  enabled: boolean;
  baseUrl: string;
  reachable: boolean;
  stats?: HeadroomStats;
}

export default function Headroom({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const resource = useKeyedClientResource(
    `headroom-status:${apiBase}`,
    [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/headroom`, { signal, cache: "no-store" });
      return await readJsonOrThrow<HeadroomState>(response, t("headroom.loadFailed"));
    },
    { pollMs: 5_000, deadlineMs: 10_000 },
  );
  const state = resource.data;
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const save = async (patch: { enabled?: boolean; baseUrl?: string }) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase}/api/headroom`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      await readJsonOrThrow<HeadroomState>(response, t("headroom.saveFailed"));
      setNotice({ tone: "ok", text: t("headroom.saved") });
      resource.refresh();
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : t("headroom.saveFailed") });
    } finally {
      setBusy(false);
    }
  };

  if (resource.error && !state) {
    return <><Notice tone="err">{t("headroom.loadFailed")}</Notice><button type="button" className="btn btn-ghost" onClick={() => void resource.refresh()}>{t("common.retry")}</button></>;
  }

  const summary = state?.stats?.summary;
  const compression = summary?.compression;
  const cost = summary?.cost;
  const baseUrlValue = baseUrlDraft ?? state?.baseUrl ?? "";

  return (
    <section className="headroom-page">
      <div className="page-head">
        <div>
          <h2>{t("headroom.title")}</h2>
          <p className="page-sub">{t("headroom.subtitle")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resource.refresh()} disabled={resource.refreshing}>
          <IconRefresh /> {t("headroom.refresh")}
        </button>
      </div>

      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      <article className="panel panel-accent">
        <div className="remote-panel-head">
          <div className="remote-icon"><IconActivity /></div>
          <div>
            <h3>{t("headroom.status.title")}</h3>
            <p>{state?.reachable ? t("headroom.status.reachable") : t("headroom.status.unreachable")}</p>
          </div>
        </div>
        <div className="headroom-controls">
          <Switch
            on={state?.enabled === true}
            onClick={() => void save({ enabled: !(state?.enabled === true) })}
            disabled={busy || !state}
            label={t("headroom.enabled")}
          />
          <span>{t("headroom.enabled")}</span>
        </div>
        <label>
          <span className="field-label">{t("headroom.baseUrl")}</span>
          <input
            className="input"
            type="text"
            value={baseUrlValue}
            onChange={event => setBaseUrlDraft(event.target.value)}
            placeholder="http://127.0.0.1:8787"
            disabled={busy}
          />
        </label>
        <div className="remote-console-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { void save({ baseUrl: baseUrlValue }).then(() => setBaseUrlDraft(null)); }}
            disabled={busy || !baseUrlValue.trim() || baseUrlValue === state?.baseUrl}
          >{t("headroom.save")}</button>
        </div>
        {state?.enabled && !state.reachable ? <Notice tone="warn">{t("headroom.unreachableWarn")}</Notice> : null}
      </article>

      <section className="panel">
        <div className="remote-section-title"><h3>{t("headroom.metrics.title")}</h3>{summary?.mode ? <span>{summary.mode}</span> : null}</div>
        {!state?.reachable ? <p className="remote-empty">{t("headroom.metrics.unavailable")}</p> : (
          <div className="headroom-metrics">
            <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.requests")}</span><strong>{summary?.api_requests ?? 0}</strong></div>
            <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.compressed")}</span><strong>{compression?.requests_compressed ?? 0}</strong></div>
            <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.tokensSaved")}</span><strong>{formatTokens(compression?.total_tokens_saved_all_layers ?? compression?.total_tokens_removed ?? 0, locale)}</strong></div>
            <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.avgCompression")}</span><strong>{(compression?.avg_compression_pct ?? 0).toFixed(1)}%</strong></div>
            <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.costSaved")}</span><strong>${(cost?.total_saved_usd ?? 0).toFixed(2)}</strong></div>
            <div className="headroom-metric"><span className="field-label">{t("headroom.metrics.savingsPct")}</span><strong>{(cost?.savings_pct ?? 0).toFixed(1)}%</strong></div>
          </div>
        )}
      </section>
    </section>
  );
}
