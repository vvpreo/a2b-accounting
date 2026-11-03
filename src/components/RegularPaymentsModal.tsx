import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n, useT } from "../i18n";
import {
  Account,
  CashDirection,
  Category,
  Transaction,
  TransactionCategoryView,
  createRegularCashEntries,
  listCategories,
  listTransactions,
  listTransactionsCategories,
} from "../lib/api";
import { formatMinorAsMoney, parseMoneyToMinor } from "../lib/money";
import {
  CategoryShare,
  defaultSourceMonth,
  firstDayOf,
  isRegular,
  monthOf,
  planRegular,
  regularKey,
  regularsIn,
  scaleShares,
  sourceByText,
} from "../lib/regular-payments";

interface Props {
  account: Account;
  onClose: () => void;
  onCreated: () => Promise<void>;
}

interface Row {
  key: number;
  include: boolean;
  date: string;
  amount: string;
  /// As in the source entry — the base for scaling the shares.
  sourceMinor: number;
  direction: CashDirection;
  shares: CategoryShare[];
  categoryNames: string;
  peer: string | null;
  comment: string | null;
  sameTextInSource: number;
}

function directionOf(x: Transaction): CashDirection {
  return Number(x.credit) > 0 ? "in" : "out";
}

function amountOf(x: Transaction): string {
  return directionOf(x) === "in" ? x.credit : x.debit;
}

/// Year and month as two selects: `<input type="month">` does not work in the
/// desktop app's WebKit.
function MonthSelect({
  value,
  onChange,
  years,
  countOf,
}: {
  value: string;
  onChange: (month: string) => void;
  years: number[];
  countOf: (month: string) => number;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [year, month] = value.split("-");
  const monthName = useMemo(() => new Intl.DateTimeFormat(locale, { month: "long" }), [locale]);
  return (
    <div className="regular-month-select">
      <select
        aria-label={t("accounts.cash.regular.selectMonth")}
        value={month}
        onChange={(e) => onChange(`${year}-${e.target.value}`)}
      >
        {Array.from({ length: 12 }, (_, i) => {
          const number = String(i + 1).padStart(2, "0");
          const count = countOf(`${year}-${number}`);
          return (
            <option key={number} value={number}>
              {monthName.format(new Date(2000, i, 1))}
              {count > 0 ? ` · ${count}` : ""}
            </option>
          );
        })}
      </select>
      <select
        aria-label={t("accounts.cash.regular.selectYear")}
        value={year}
        onChange={(e) => onChange(`${e.target.value}-${month}`)}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}

/// Records → "Regular payments": enter the month's recurring cash payments the
/// way another month has them. An entry is regular when its comment starts
/// with 🔄; the wizard shows what the target month has, takes a source month and
/// previews what stays and what appears. Nothing is written before the last step.
export function RegularPaymentsModal({ account, onClose, onCreated }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [txns, setTxns] = useState<Transaction[] | null>(null);
  const [shareViews, setShareViews] = useState<TransactionCategoryView[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [target, setTarget] = useState(() => monthOf(new Date()));
  // Null until the owner chooses: follows the target month.
  const [chosenSource, setChosenSource] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dateForAll, setDateForAll] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listTransactions([account.id]), listTransactionsCategories([account.id]), listCategories()])
      .then(([loaded, views, cats]) => {
        setTxns(loaded);
        setShareViews(views);
        setCategories(cats);
      })
      .catch((e) => setError(String(e)));
  }, [account.id]);

  const all = useMemo(() => txns ?? [], [txns]);
  const source = chosenSource ?? defaultSourceMonth(all, target);
  const targetEntries = useMemo(() => regularsIn(all, target), [all, target]);
  const sourceEntries = useMemo(() => regularsIn(all, source), [all, source]);
  const plan = useMemo(() => planRegular(all, target, source), [all, target, source]);
  const sourceTexts = useMemo(() => sourceByText(all, source), [all, source]);

  const regularCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const x of all) {
      if (!isRegular(x.comment)) continue;
      const month = monthOf(x.occurredAtUtc);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    return counts;
  }, [all]);
  const countOf = (month: string) => regularCounts.get(month) ?? 0;

  const years = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const dataYears = all.map((x) => new Date(x.occurredAtUtc).getFullYear());
    const first = Math.min(thisYear - 1, ...dataYears);
    const last = Math.max(thisYear + 1, ...dataYears);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  }, [all]);

  const monthTitle = useMemo(() => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }), [locale]);
  const titleOf = (month: string) => {
    const [y, m] = month.split("-").map(Number);
    return monthTitle.format(new Date(y, m - 1, 1));
  };
  const dateFmt = useMemo(() => new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }), [locale]);
  const moneyFmt = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: account.currency });
    } catch {
      return null;
    }
  }, [locale, account.currency]);
  const money = (amount: string) => {
    const n = Number(amount);
    return moneyFmt ? moneyFmt.format(n) : `${amount} ${account.currency}`;
  };
  const signed = (x: Transaction) => `${directionOf(x) === "in" ? "+" : "−"}${money(amountOf(x))}`;

  function toPreview() {
    // The `<<--->>` transfer categories belong to linked pairs, a category of
    // the other kind cannot be saved: neither goes over to the copy.
    const system = new Set(categories.filter((c) => c.systemKey).map((c) => c.id));
    const next = plan.toCreate.map(({ source: x, sameTextInSource }): Row => {
      const direction = directionOf(x);
      const fitting = shareViews.filter(
        (v) =>
          v.transactionId === x.id &&
          !system.has(v.categoryId) &&
          v.categoryKind === (direction === "in" ? "income" : "expense"),
      );
      const amount = amountOf(x);
      return {
        key: x.id,
        include: (parseMoneyToMinor(amount) ?? 0) > 0,
        date: firstDayOf(target),
        amount,
        sourceMinor: parseMoneyToMinor(amount) ?? 0,
        direction,
        shares: fitting.map((v) => ({ categoryId: v.categoryId, shareMinor: v.shareMinor })),
        categoryNames: fitting.map((v) => v.categoryName).join(", "),
        peer: x.peer,
        comment: x.comment,
        sameTextInSource,
      };
    });
    setRows(next);
    setDateForAll(firstDayOf(target));
    setError(null);
    setStep(3);
  }

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  const included = rows.filter((r) => r.include);
  const dateFits = (date: string) => date.startsWith(`${target}-`);
  const amountFits = (amount: string) => (parseMoneyToMinor(amount) ?? 0) > 0;
  const invalid = included.some((r) => !dateFits(r.date) || !amountFits(r.amount));
  const totalOf = (direction: CashDirection) =>
    included
      .filter((r) => r.direction === direction)
      .reduce((sum, r) => sum + (parseMoneyToMinor(r.amount) ?? 0), 0);

  async function create() {
    if (included.length === 0 || invalid) return;
    setBusy(true);
    setError(null);
    try {
      // Another tab may have entered a payment since this preview was built;
      // the month must still end up with one payment per text.
      const fresh = await listTransactions([account.id]);
      const taken = new Set(regularsIn(fresh, target).map((x) => regularKey(x.comment)));
      const entries = included
        .filter((r) => !taken.has(regularKey(r.comment)))
        .map((r) => {
          const minor = parseMoneyToMinor(r.amount) ?? 0;
          return {
            // Midday local: a UTC day boundary must not move an entry into the
            // neighbouring month of the report.
            occurredAtUtc: new Date(`${r.date}T12:00`).toISOString(),
            direction: r.direction,
            amount: formatMinorAsMoney(minor),
            categories: scaleShares(r.shares, r.sourceMinor, minor).map((s, position) => ({ ...s, position })),
            peer: r.peer,
            comment: r.comment,
          };
        });
      await createRegularCashEntries({ accountId: account.id, entries });
      await onCreated();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const entryList = (entries: Transaction[]) =>
    entries.length === 0 ? (
      <p className="empty">{t("accounts.cash.regular.noneYet")}</p>
    ) : (
      <table className="cash-dictation-table regular-list">
        <tbody>
          {entries.map((x) => {
            const inSource = sourceTexts.get(regularKey(x.comment));
            const differs = step === 3 && inSource && amountOf(inSource) !== amountOf(x);
            return (
              <tr key={x.id}>
                <td>{dateFmt.format(new Date(x.occurredAtUtc))}</td>
                <td className="regular-amount">{signed(x)}</td>
                <td>{x.comment?.trim()}</td>
                <td className="cash-dictation-marks">
                  {differs && (
                    <span className="cash-dictation-mark" title={t("accounts.cash.regular.inSourceHint")}>
                      {t("accounts.cash.regular.inSource", { amount: money(amountOf(inSource)) })}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );

  const sourceProblem =
    source === target
      ? t("accounts.cash.regular.sameMonth")
      : sourceEntries.length === 0
        ? t("accounts.cash.regular.noneInSource")
        : null;

  return createPortal(
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className={`modal ${step === 3 ? "modal--regular-preview" : "modal--cash-dictation"}`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t("accounts.cash.regular.title", { account: account.name || account.currency })}</h3>
          {!busy && (
            <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
              ×
            </button>
          )}
        </header>

        <div className="modal-body">
          <p className="hint">{t("accounts.cash.regular.step", { step })}</p>

          {step === 1 && txns && (
            <>
              <p className="regular-question">{t("accounts.cash.regular.targetQuestion")}</p>
              <MonthSelect
                value={target}
                onChange={(month) => {
                  setTarget(month);
                  setChosenSource(null);
                }}
                years={years}
                countOf={countOf}
              />
              <h4 className="regular-heading">
                {t("accounts.cash.regular.existingIn", { month: titleOf(target), count: targetEntries.length })}
              </h4>
              {entryList(targetEntries)}
            </>
          )}

          {step === 2 && (
            <>
              <p className="regular-question">{t("accounts.cash.regular.sourceQuestion")}</p>
              <MonthSelect value={source} onChange={setChosenSource} years={years} countOf={countOf} />
              {sourceProblem && <div className="cash-dictation-notes">{sourceProblem}</div>}
              {source !== target && sourceEntries.length > 0 && (
                <>
                  <h4 className="regular-heading">
                    {t("accounts.cash.regular.sourceIn", { month: titleOf(source), count: sourceEntries.length })}
                  </h4>
                  {entryList(sourceEntries)}
                </>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <h4 className="regular-heading">
                {t("accounts.cash.regular.existingIn", { month: titleOf(target), count: plan.existing.length })}
              </h4>
              {entryList(plan.existing)}

              <h4 className="regular-heading">{t("accounts.cash.regular.toCreate", { count: rows.length })}</h4>
              {rows.length === 0 ? (
                <p className="empty">{t("accounts.cash.regular.allThere")}</p>
              ) : (
                <>
                  <label className="regular-date-all">
                    {t("accounts.cash.regular.dateForAll")}
                    <input
                      type="date"
                      value={dateForAll}
                      min={firstDayOf(target)}
                      onChange={(e) => {
                        const date = e.target.value;
                        setDateForAll(date);
                        if (date) setRows((rs) => rs.map((r) => ({ ...r, date })));
                      }}
                    />
                  </label>
                  <div className="cash-dictation-summary">
                    <span>{t("accounts.cash.regular.summary", { count: included.length, total: rows.length })}</span>
                    {totalOf("out") > 0 && (
                      <span>{t("accounts.cash.dictation.totalOut", { amount: money(formatMinorAsMoney(totalOf("out"))) })}</span>
                    )}
                    {totalOf("in") > 0 && (
                      <span>{t("accounts.cash.dictation.totalIn", { amount: money(formatMinorAsMoney(totalOf("in"))) })}</span>
                    )}
                  </div>
                  <table className="cash-dictation-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={included.length === rows.length}
                            onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, include: e.target.checked })))}
                            aria-label={t("accounts.cash.dictation.colInclude")}
                          />
                        </th>
                        <th>{t("accounts.cash.colDate")}</th>
                        <th>{t("accounts.cash.dictation.colDirection")}</th>
                        <th>{t("accounts.cash.colAmount")}</th>
                        <th>{t("accounts.cash.colComment")}</th>
                        <th>{t("accounts.cash.dictation.colCategory")}</th>
                        <th>{t("accounts.cash.colPeer")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className={r.include ? undefined : "is-excluded"}>
                          <td>
                            <input
                              type="checkbox"
                              checked={r.include}
                              onChange={(e) => update(r.key, { include: e.target.checked })}
                            />
                          </td>
                          <td>
                            <input
                              type="date"
                              value={r.date}
                              className={r.include && !dateFits(r.date) ? "is-invalid" : undefined}
                              title={dateFits(r.date) ? undefined : t("accounts.cash.regular.dateOutOfMonth")}
                              onChange={(e) => update(r.key, { date: e.target.value })}
                            />
                          </td>
                          <td>{t(r.direction === "in" ? "accounts.cash.dictation.in" : "accounts.cash.dictation.out")}</td>
                          <td>
                            <input
                              inputMode="decimal"
                              className={`cash-dictation-amount${r.include && !amountFits(r.amount) ? " is-invalid" : ""}`}
                              value={r.amount}
                              onChange={(e) => update(r.key, { amount: e.target.value })}
                            />
                          </td>
                          <td>{r.comment?.trim()}</td>
                          <td>
                            {r.categoryNames || (
                              <span className="cash-dictation-placeholder">{t("accounts.cash.regular.noCategory")}</span>
                            )}
                          </td>
                          <td>{r.peer ?? ""}</td>
                          <td className="cash-dictation-marks">
                            {r.sameTextInSource > 1 && (
                              <span className="cash-dictation-mark is-warn" title={t("accounts.cash.regular.sameTextHint")}>
                                {t("accounts.cash.regular.sameText", { count: r.sameTextInSource })}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}

          {error && <div className="error">{error}</div>}
        </div>

        <footer className="modal-footer">
          {step > 1 && (
            <button
              type="button"
              className="btn-ghost modal-footer-left"
              onClick={() => setStep(step === 3 ? 2 : 1)}
              disabled={busy}
            >
              {t("accounts.cash.regular.back")}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          {step === 1 && (
            <button type="button" className="btn-primary" onClick={() => setStep(2)} disabled={!txns}>
              {t("accounts.cash.regular.next")}
            </button>
          )}
          {step === 2 && (
            <button type="button" className="btn-primary" onClick={toPreview} disabled={sourceProblem !== null}>
              {t("accounts.cash.regular.next")}
            </button>
          )}
          {step === 3 && rows.length > 0 && (
            <button
              type="button"
              className="btn-primary"
              onClick={create}
              disabled={busy || included.length === 0 || invalid}
            >
              {busy ? t("common.saving") : t("accounts.cash.regular.create", { count: included.length })}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
