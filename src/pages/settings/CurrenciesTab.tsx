import { useCallback, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "../../lib/events";

import {
  CurrencyRateSummary,
  downloadRatesForCurrency,
  listCurrencyRateSummaries,
  listRateEntriesForCurrency,
  RateEntry,
} from "../../lib/api";
import { useI18n, useT } from "../../i18n";
import { RateWeeksTable } from "../../components/RateWeeksTable";

type DownloadEvent = { currency: string; error?: string; inserted?: number };

export function CurrenciesTab() {
  const t = useT();
  const { locale } = useI18n();

  const [summaries, setSummaries] = useState<CurrencyRateSummary[]>([]);
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [entries, setEntries] = useState<RateEntry[]>([]);
  const [busyCurrencies, setBusyCurrencies] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refreshSummaries = useCallback(async () => {
    try {
      const rows = await listCurrencyRateSummaries();
      setSummaries(rows);
      setActiveCode((prev) => {
        if (prev && rows.some((r) => r.code === prev)) return prev;
        return rows[0]?.code ?? null;
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refreshSummaries();
  }, [refreshSummaries]);

  // Reload weekly entries when active currency changes.
  useEffect(() => {
    if (!activeCode) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    listRateEntriesForCurrency(activeCode)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activeCode]);

  // Subscribe to backend rate-download events to track in-flight downloads
  // (auto-trigger from create-account or manual refresh button) and refresh
  // the UI when a download finishes.
  useEffect(() => {
    let unlisten1: UnlistenFn | undefined;
    let unlisten2: UnlistenFn | undefined;
    let unlisten3: UnlistenFn | undefined;
    (async () => {
      unlisten1 = await listen<DownloadEvent>("rates:download:started", (e) => {
        setBusyCurrencies((prev) => {
          const next = new Set(prev);
          next.add(e.payload.currency);
          return next;
        });
      });
      unlisten2 = await listen<DownloadEvent>(
        "rates:download:completed",
        async (e) => {
          setBusyCurrencies((prev) => {
            const next = new Set(prev);
            next.delete(e.payload.currency);
            return next;
          });
          await refreshSummaries();
          if (activeCode === e.payload.currency) {
            try {
              setEntries(await listRateEntriesForCurrency(activeCode));
            } catch (err) {
              setError(String(err));
            }
          }
        },
      );
      unlisten3 = await listen<DownloadEvent>(
        "rates:download:failed",
        (e) => {
          setBusyCurrencies((prev) => {
            const next = new Set(prev);
            next.delete(e.payload.currency);
            return next;
          });
          setError(
            t("settings.currencies.downloadFailed", {
              currency: e.payload.currency,
              error: e.payload.error ?? "",
            }),
          );
        },
      );
    })();
    return () => {
      unlisten1?.();
      unlisten2?.();
      unlisten3?.();
    };
  }, [activeCode, refreshSummaries, t]);

  const active = useMemo(
    () => summaries.find((s) => s.code === activeCode) ?? null,
    [summaries, activeCode],
  );

  async function onRefreshActive() {
    if (!active) return;
    setError(null);
    setBusyCurrencies((prev) => {
      const next = new Set(prev);
      next.add(active.code);
      return next;
    });
    try {
      await downloadRatesForCurrency(active.code);
    } catch (e) {
      setError(String(e));
      setBusyCurrencies((prev) => {
        const next = new Set(prev);
        next.delete(active.code);
        return next;
      });
    }
  }

  return (
    <div className="settings-currencies">
      {error && <div className="error">{error}</div>}

      {summaries.length === 0 ? (
        <p className="settings-hint">{t("settings.currencies.empty")}</p>
      ) : (
        <div className="currencies-layout">
          <ul className="currencies-list">
            {summaries.map((s) => {
              const busy = busyCurrencies.has(s.code);
              return (
                <li key={s.code}>
                  <button
                    type="button"
                    className={
                      "currency-card" +
                      (s.code === activeCode ? " currency-card--active" : "")
                    }
                    onClick={() => setActiveCode(s.code)}
                  >
                    <div className="currency-card-head">
                      <span className="currency-card-code">{s.code}</span>
                      <span className="currency-card-symbol">{s.symbol}</span>
                    </div>
                    <div className="currency-card-name">{s.name}</div>
                    <div className="currency-card-meta">
                      {s.rateSource ?? "—"}
                    </div>
                    <div className="currency-card-meta">
                      {t("settings.currencies.summaryLine", {
                        count: String(s.rateCount),
                        earliest: s.earliestDate,
                        latest: s.latestDate,
                      })}
                    </div>
                    {busy && (
                      <div className="currency-card-meta">
                        {t("settings.currencies.loading")}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="currencies-detail">
            {active ? (
              <>
                <header className="currencies-detail-head">
                  <h3>
                    {active.code} — {active.name} ({active.symbol})
                  </h3>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={onRefreshActive}
                    disabled={
                      busyCurrencies.has(active.code) ||
                      active.code.toUpperCase() === "EUR"
                    }
                  >
                    {busyCurrencies.has(active.code)
                      ? t("settings.currencies.loading")
                      : t("settings.currencies.refresh")}
                  </button>
                </header>
                <p className="settings-hint">
                  {t("settings.currencies.source")}: {active.rateSource ?? "—"}
                </p>
                <p className="settings-hint">
                  {t("settings.currencies.baseHint", { code: active.code })}
                </p>
                <RateWeeksTable entries={entries} locale={locale} />
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
