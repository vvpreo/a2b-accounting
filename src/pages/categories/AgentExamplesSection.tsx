import { ReactNode, useEffect, useMemo, useState } from "react";

import { useI18n, useT } from "../../i18n";
import {
  Category,
  CategoryExamplesReport,
  ExamplesIssue,
  ExamplesReport,
  Transaction,
  categoryExamplesReport,
  listTransactions,
  setCategoryExamples,
} from "../../lib/api";
import { formatMoney } from "../../lib/money";
import { useViewState } from "../../lib/view-state";

interface Props {
  categories: Category[];
}

/// How many of a long list are shown before "Show all".
const LIST_LIMIT = 20;

/// Categories screen → "Examples for the agent": per category, whether the
/// agent has enough of the user's own categorisations to follow — how many
/// there are, which ones the model sees, counterparties with mixed answers
/// and the agent's own mistakes. Every row has ☆/★ to mark an example; the
/// Transactions screen marks them too (★ in the category cell, Actions ▾).
export function AgentExamplesSection({ categories }: Props) {
  const t = useT();
  const { locale, tPlural } = useI18n();
  const [report, setReport] = useState<ExamplesReport | null>(null);
  const [txns, setTxns] = useState<Map<number, Transaction>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [onlyIssues, setOnlyIssues] = useViewState("categories.examples.onlyIssues", false);
  const [expanded, setExpanded] = useViewState<number[]>("categories.examples.expanded", []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([categoryExamplesReport(), listTransactions()])
      .then(([r, list]) => {
        if (cancelled) return;
        setReport(r);
        setTxns(new Map(list.map((x) => [x.id, x])));
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const pathOf = useMemo(
    () => (id: number) => {
      const names: string[] = [];
      for (let c = byId.get(id); c && names.length < 8; c = c.parentId === null ? undefined : byId.get(c.parentId)) {
        names.unshift(c.name);
      }
      return names.join(" / ");
    },
    [byId],
  );
  const rows = useMemo(() => {
    const list = (report?.categories ?? []).filter((r) => byId.has(r.categoryId));
    // Tree order: income then expense, by path.
    list.sort((a, b) => {
      const ka = byId.get(a.categoryId)!.kind;
      const kb = byId.get(b.categoryId)!.kind;
      return ka === kb ? pathOf(a.categoryId).localeCompare(pathOf(b.categoryId), locale) : ka === "income" ? -1 : 1;
    });
    return list;
  }, [report, byId, pathOf, locale]);
  const marked = useMemo(() => new Set(rows.flatMap((r) => r.marked)), [rows]);
  const withIssues = rows.filter((r) => r.issues.length > 0).length;
  const n = report?.examplesPerCategory ?? 0;

  async function toggle(id: number, example: boolean) {
    try {
      await setCategoryExamples([id], example);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleExpanded(id: number) {
    setExpanded((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  }

  const txnRow = (id: number, note?: string) => {
    const x = txns.get(id);
    if (!x) return null;
    const isMarked = marked.has(id);
    const amount = x.credit !== "0.00" ? `+${formatMoney(x.credit)}` : `−${formatMoney(x.debit)}`;
    return (
      <li key={id} className={isMarked ? "agent-example is-marked" : "agent-example"}>
        <button
          type="button"
          className="agent-example-star"
          title={isMarked ? t("categories.examples.unmark") : t("categories.examples.mark")}
          aria-pressed={isMarked}
          onClick={() => void toggle(id, !isMarked)}
        >
          {isMarked ? "★" : "☆"}
        </button>
        <span className="agent-example-date">{new Date(x.occurredAtUtc).toLocaleDateString(locale)}</span>
        <span className="agent-example-amount">{amount}</span>
        <span className="agent-example-text">
          {x.peer || x.bankDescription || ""}
          {x.comment && <span className="hint"> · {x.comment}</span>}
        </span>
        {note && <span className="agent-example-note">{note}</span>}
      </li>
    );
  };

  const issueLabel = (r: CategoryExamplesReport, issue: ExamplesIssue) =>
    t(`categories.examples.issue.${issue}`, {
      count:
        issue === "agent_misses"
          ? r.agentMisses.filter((m) => !marked.has(m.transactionId)).length
          : issue === "conflicts"
            ? r.conflicts.filter((c) => !c.resolved).length
            : r.labeled.length,
      n,
    });

  const visible = onlyIssues ? rows.filter((r) => r.issues.length > 0) : rows;

  return (
    <div className="categories-section agent-examples">
      <p className="hint">{t("categories.examples.hint", { n })}</p>
      {report && !report.autoExamples && <p className="hint">{t("categories.examples.autoOff")}</p>}
      {error && <div className="error">{error}</div>}
      {report && (
        <div className="agent-examples-toolbar">
          <span>{t("categories.examples.summary", { count: withIssues, total: rows.length })}</span>
          <label className="checkbox-row">
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
            <span>{t("categories.examples.onlyIssues")}</span>
          </label>
        </div>
      )}
      {report && rows.length === 0 && <p className="hint">{t("categories.examples.empty")}</p>}
      {visible.length > 0 && (
        <div className="agent-examples-table" role="table">
          <div className="agent-examples-head" role="row">
            <span role="columnheader">{t("categories.examples.col.category")}</span>
            <span role="columnheader">{t("categories.examples.col.labeled")}</span>
            <span role="columnheader">{t("categories.examples.col.examples")}</span>
            <span role="columnheader">{t("categories.examples.col.agent")}</span>
            <span role="columnheader">{t("categories.examples.col.issues")}</span>
          </div>
          {visible.map((r) => {
            const c = byId.get(r.categoryId)!;
            const open = expanded.includes(r.categoryId);
            const misses = r.agentMisses.length;
            return (
              <div key={r.categoryId} className={open ? "agent-examples-item is-open" : "agent-examples-item"}>
                <button
                  type="button"
                  className="agent-examples-row"
                  role="row"
                  aria-expanded={open}
                  onClick={() => toggleExpanded(r.categoryId)}
                >
                  <span className="agent-examples-name" role="cell">
                    <span className="agent-examples-caret" aria-hidden="true">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="categories-swatch" style={{ backgroundColor: c.color }} aria-hidden="true" />
                    {pathOf(r.categoryId)}
                  </span>
                  <span role="cell">
                    {r.labeled.length > 0
                      ? t("categories.examples.labeledValue", {
                          count: r.labeled.length,
                          peers: tPlural("categories.examples.peers", r.peers),
                        })
                      : "—"}
                  </span>
                  <span role="cell">
                    {t("categories.examples.examplesValue", {
                      shown: r.marked.length + r.auto.length,
                      marked: r.marked.length,
                    })}
                  </span>
                  <span role="cell">
                    {r.agentHits + misses > 0
                      ? t("categories.examples.agentValue", { hits: r.agentHits, misses })
                      : "—"}
                  </span>
                  <span className="agent-examples-issues" role="cell">
                    {r.issues.length === 0 ? (
                      <span className="agent-issue is-ok">✓</span>
                    ) : (
                      r.issues.map((issue) => (
                        <span key={issue} className={`agent-issue is-${issue}`}>
                          {issueLabel(r, issue)}
                        </span>
                      ))
                    )}
                  </span>
                </button>
                {open && (
                  <CategoryDetails
                    report={r}
                    n={n}
                    marked={marked}
                    pathOf={pathOf}
                    txnRow={txnRow}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryDetails({
  report: r,
  n,
  marked,
  pathOf,
  txnRow,
}: {
  report: CategoryExamplesReport;
  n: number;
  marked: Set<number>;
  pathOf: (id: number) => string;
  txnRow: (id: number, note?: string) => ReactNode;
}) {
  const t = useT();
  const [allOpen, setAllOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const seen = [...r.marked, ...r.auto];
  const help = (issue: ExamplesIssue) =>
    r.issues.includes(issue) && (
      <p className="hint agent-issue-help">{t(`categories.examples.help.${issue}`, { n, count: r.marked.length })}</p>
    );

  return (
    <div className="agent-examples-details">
      {help("no_examples")}
      {help("few_examples")}

      {seen.length > 0 && (
        <section>
          <h4>{t("categories.examples.seen", { count: seen.length })}</h4>
          <ul>{seen.map((id) => txnRow(id, marked.has(id) ? undefined : t("categories.examples.auto")))}</ul>
        </section>
      )}

      {r.agentMisses.length > 0 && (
        <section>
          <h4>{t("categories.examples.misses", { count: r.agentMisses.length })}</h4>
          {help("agent_misses")}
          <ul>
            {r.agentMisses.map((m) =>
              txnRow(m.transactionId, t("categories.examples.missNote", { path: pathOf(m.suggestedCategoryId) })),
            )}
          </ul>
        </section>
      )}
      {r.agentFalse > 0 && <p className="hint">{t("categories.examples.agentFalse", { count: r.agentFalse })}</p>}

      {r.conflicts.length > 0 && (
        <section>
          <h4>{t("categories.examples.conflicts", { count: r.conflicts.length })}</h4>
          {help("conflicts")}
          {r.conflicts.map((c) => (
            <div key={c.peer} className={c.resolved ? "agent-conflict is-resolved" : "agent-conflict"}>
              <div className="agent-conflict-title">
                <strong>{c.peer}</strong>
                <span className="hint">
                  {" "}
                  {t("categories.examples.conflictHere", { count: c.here.length })}
                  {c.elsewhere.map((e) => (
                    <span key={e.categoryId}>
                      {" · "}
                      {pathOf(e.categoryId)}: {e.transactions.length}
                    </span>
                  ))}
                </span>
                {c.resolved && <span className="agent-issue is-ok">✓</span>}
              </div>
              <ul>
                {c.here.slice(0, 5).map((id) => txnRow(id))}
                {c.elsewhere.flatMap((e) => e.transactions.slice(0, 5).map((id) => txnRow(id, pathOf(e.categoryId))))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {r.labeled.length > 0 && (
        <section>
          <h4>
            <button type="button" className="link-btn" aria-expanded={allOpen} onClick={() => setAllOpen((v) => !v)}>
              {allOpen ? "▾" : "▸"} {t("categories.examples.allLabeled", { count: r.labeled.length })}
            </button>
          </h4>
          {allOpen && (
            <>
              <ul>{(showAll ? r.labeled : r.labeled.slice(0, LIST_LIMIT)).map((id) => txnRow(id))}</ul>
              {!showAll && r.labeled.length > LIST_LIMIT && (
                <button type="button" className="link-btn" onClick={() => setShowAll(true)}>
                  {t("categories.examples.showAll")}
                </button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
