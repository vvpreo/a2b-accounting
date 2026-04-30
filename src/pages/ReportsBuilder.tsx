import { FormEvent, useEffect, useMemo, useState } from "react";

import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import { useT } from "../i18n";
import {
  Account,
  Category,
  CategoryKind,
  Granularity,
  RangePreset,
  ReportConfig,
  ReportRange,
  ReportView,
  createReportView,
  deleteReportView,
  listAccounts,
  listCategories,
  updateReportView,
} from "../lib/api";
import { buildTree, flattenTree } from "../lib/category-tree";

interface Props {
  editId: number | null;
  reportViews: ReportView[];
  onSaved: (view: ReportView) => void;
  onDeleted: () => void;
}

const PRESETS: RangePreset[] = [
  "current_month",
  "current_quarter",
  "current_year",
  "last_12_months",
  "all_time",
  "custom",
];

const GRANULARITIES: Granularity[] = ["year", "quarter", "month"];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function firstOfMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function defaultConfig(): ReportConfig {
  return {
    version: 1,
    accountIds: [],
    expenseCategoryIds: [],
    incomeCategoryIds: [],
    expenseShowUncategorized: false,
    incomeShowUncategorized: false,
    defaultRange: { kind: "preset", preset: "current_year" },
    defaultGranularity: "month",
    expandedCategoryIds: [],
  };
}

function safeParseConfig(raw: string): ReportConfig {
  try {
    const parsed = JSON.parse(raw) as Partial<ReportConfig> & { showUncategorized?: boolean };
    const base = defaultConfig();
    // Backwards compat: an older saved view used a single `showUncategorized`
    // flag for both sections — propagate it to both new fields if present.
    const legacyFallback = parsed.showUncategorized;
    return {
      ...base,
      ...parsed,
      expenseShowUncategorized:
        parsed.expenseShowUncategorized ?? legacyFallback ?? base.expenseShowUncategorized,
      incomeShowUncategorized:
        parsed.incomeShowUncategorized ?? legacyFallback ?? base.incomeShowUncategorized,
    };
  } catch {
    return defaultConfig();
  }
}

export function ReportsBuilderPage({ editId, reportViews, onSaved, onDeleted }: Props) {
  const t = useT();

  const editing = editId != null ? reportViews.find((v) => v.id === editId) ?? null : null;
  const initialConfig = useMemo(
    () => (editing ? safeParseConfig(editing.config) : defaultConfig()),
    [editing],
  );

  const [name, setName] = useState(editing?.name ?? "");
  const [accountIds, setAccountIds] = useState<number[]>(initialConfig.accountIds);
  const [expenseIds, setExpenseIds] = useState<number[]>(initialConfig.expenseCategoryIds);
  const [incomeIds, setIncomeIds] = useState<number[]>(initialConfig.incomeCategoryIds);
  const [expenseShowUncat, setExpenseShowUncat] = useState(initialConfig.expenseShowUncategorized);
  const [incomeShowUncat, setIncomeShowUncat] = useState(initialConfig.incomeShowUncategorized);
  const [range, setRange] = useState<ReportRange>(initialConfig.defaultRange);
  const [granularity, setGranularity] = useState<Granularity>(initialConfig.defaultGranularity);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset form when switching between create/edit modes (or between different views).
  useEffect(() => {
    setName(editing?.name ?? "");
    const cfg = editing ? safeParseConfig(editing.config) : defaultConfig();
    setAccountIds(cfg.accountIds);
    setExpenseIds(cfg.expenseCategoryIds);
    setIncomeIds(cfg.incomeCategoryIds);
    setExpenseShowUncat(cfg.expenseShowUncategorized);
    setIncomeShowUncat(cfg.incomeShowUncategorized);
    setRange(cfg.defaultRange);
    setGranularity(cfg.defaultGranularity);
    setError(null);
    setConfirmingDelete(false);
  }, [editId, editing]);

  useEffect(() => {
    Promise.all([listAccounts(), listCategories()])
      .then(([accs, cats]) => {
        setAccounts(accs);
        setCategories(cats);
      })
      .catch((e) => setError(String(e)));
  }, []);

  function setRangeKind(next: RangePreset) {
    if (next === "custom") {
      const from = range.kind === "custom" ? range.from : firstOfMonthIso();
      const to = range.kind === "custom" ? range.to : todayIso();
      setRange({ kind: "custom", from, to });
    } else {
      setRange({ kind: "preset", preset: next });
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError(t("builder.errorEmptyName"));
      return;
    }
    if (accountIds.length === 0) {
      setError(t("builder.errorNoAccounts"));
      return;
    }
    const expenseHasContent = expenseIds.length > 0 || expenseShowUncat;
    const incomeHasContent = incomeIds.length > 0 || incomeShowUncat;
    if (!expenseHasContent && !incomeHasContent) {
      setError(t("builder.errorNoCategories"));
      return;
    }
    if (range.kind === "custom" && range.from && range.to && range.to < range.from) {
      setError(t("builder.errorBadDates"));
      return;
    }

    const config: ReportConfig = {
      version: 1,
      accountIds,
      expenseCategoryIds: expenseIds,
      incomeCategoryIds: incomeIds,
      expenseShowUncategorized: expenseShowUncat,
      incomeShowUncategorized: incomeShowUncat,
      defaultRange: range,
      defaultGranularity: granularity,
      expandedCategoryIds: initialConfig.expandedCategoryIds,
    };
    const payload = JSON.stringify(config);

    setSubmitting(true);
    try {
      const saved =
        editing != null
          ? await updateReportView({ id: editing.id, name: name.trim(), config: payload })
          : await createReportView({ name: name.trim(), config: payload });
      onSaved(saved);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete() {
    if (!editing) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteReportView(editing.id);
      onDeleted();
    } catch (err) {
      setError(String(err));
      setDeleting(false);
    }
  }

  return (
    <section className="page builder-page">
      <header className="builder-header">
        <h2>{editing ? t("builder.titleEdit") : t("builder.titleCreate")}</h2>
      </header>

      {error && <div className="error">{error}</div>}

      <form className="builder-form" onSubmit={onSubmit}>
        <div className="builder-row">
          <label htmlFor="builder-name">{t("builder.fieldName")}</label>
          <input
            id="builder-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("builder.fieldNamePlaceholder")}
            autoComplete="off"
          />
        </div>

        <div className="builder-row">
          <label>{t("builder.accountsLabel")}</label>
          <MultiSelectDropdown<number>
            items={accounts.map((a) => ({ id: a.id, label: a.name }))}
            selected={accountIds}
            onApply={setAccountIds}
            allLabel={t("builder.accountsAll")}
            noneLabel={t("builder.accountsNone")}
            emptyItemsLabel={t("builder.accountsEmpty")}
            multiSelectedLabel={(count) => t("builder.accountsMany", { count })}
            applyLabel={t("builder.accountsApply")}
          />
        </div>

        <div className="builder-sections">
          <CategorySection
            title={t("builder.sectionExpense")}
            kind="expense"
            categories={categories}
            selected={expenseIds}
            onChange={setExpenseIds}
            showUncategorized={expenseShowUncat}
            onChangeShowUncategorized={setExpenseShowUncat}
          />
          <CategorySection
            title={t("builder.sectionIncome")}
            kind="income"
            categories={categories}
            selected={incomeIds}
            onChange={setIncomeIds}
            showUncategorized={incomeShowUncat}
            onChangeShowUncategorized={setIncomeShowUncat}
          />
        </div>

        <div className="builder-defaults">
          <h3>{t("builder.defaults")}</h3>
          <p className="settings-hint">{t("builder.defaultsHint")}</p>
          <div className="builder-defaults-grid">
            <label>
              <span>{t("builder.defaultRange")}</span>
              <select
                value={range.kind === "preset" ? range.preset : "custom"}
                onChange={(e) => setRangeKind(e.target.value as RangePreset)}
              >
                {PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {t(`builder.preset.${p}`)}
                  </option>
                ))}
              </select>
            </label>
            {range.kind === "custom" && (
              <>
                <label>
                  <span>{t("builder.fromDate")}</span>
                  <input
                    type="date"
                    value={range.from}
                    onChange={(e) => setRange({ ...range, from: e.target.value })}
                  />
                </label>
                <label>
                  <span>{t("builder.toDate")}</span>
                  <input
                    type="date"
                    value={range.to}
                    onChange={(e) => setRange({ ...range, to: e.target.value })}
                  />
                </label>
              </>
            )}
            <label>
              <span>{t("builder.defaultGranularity")}</span>
              <select
                value={granularity}
                onChange={(e) => setGranularity(e.target.value as Granularity)}
              >
                {GRANULARITIES.map((g) => (
                  <option key={g} value={g}>
                    {t(`builder.granularity.${g}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="builder-actions">
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting
              ? t("builder.saving")
              : editing
              ? t("builder.save")
              : t("builder.create")}
          </button>
          {editing && !confirmingDelete && (
            <button
              type="button"
              className="btn-danger-ghost"
              onClick={() => setConfirmingDelete(true)}
              disabled={submitting || deleting}
            >
              {t("builder.delete")}
            </button>
          )}
          {editing && confirmingDelete && (
            <span className="confirm-inline confirm-inline--actions">
              <span className="confirm-inline-text">
                {t("builder.deleteConfirm", { name: editing.name })}
              </span>
              <button
                type="button"
                className="btn-danger btn-sm"
                onClick={onDelete}
                disabled={deleting}
              >
                {t("builder.deleteConfirmYes")}
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
              >
                {t("common.cancel")}
              </button>
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

interface CategorySectionProps {
  title: string;
  kind: CategoryKind;
  categories: Category[];
  selected: number[];
  onChange: (next: number[]) => void;
  showUncategorized: boolean;
  onChangeShowUncategorized: (next: boolean) => void;
}

function CategorySection({
  title,
  kind,
  categories,
  selected,
  onChange,
  showUncategorized,
  onChangeShowUncategorized,
}: CategorySectionProps) {
  const t = useT();
  const tree = useMemo(() => buildTree(categories, kind), [categories, kind]);
  const flat = useMemo(() => flattenTree(tree), [tree]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const byId = useMemo(() => {
    const m = new Map<number, Category>();
    for (const c of categories) m.set(c.id, c);
    return m;
  }, [categories]);

  function toggle(id: number) {
    if (selectedSet.has(id)) {
      onChange(selected.filter((x) => x !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  function move(idx: number, delta: number) {
    const next = [...selected];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  }

  function remove(id: number) {
    onChange(selected.filter((x) => x !== id));
  }

  const nothingSelected = selected.length === 0 && !showUncategorized;

  return (
    <div className="builder-section">
      <h3 className="builder-section-title">{title}</h3>
      {flat.length === 0 ? (
        <p className="builder-section-empty">{t("categories.empty")}</p>
      ) : (
        <ul className="builder-tree">
          {flat.map((node) => (
            <li
              key={node.category.id}
              className="builder-tree-row"
              style={{ paddingLeft: `${node.depth * 18}px` }}
            >
              <label>
                <input
                  type="checkbox"
                  checked={selectedSet.has(node.category.id)}
                  onChange={() => toggle(node.category.id)}
                />
                <span
                  className="builder-tree-swatch"
                  style={{ background: node.category.color }}
                  aria-hidden
                />
                <span className="builder-tree-name">{node.category.name}</span>
              </label>
            </li>
          ))}
          <li className="builder-tree-row builder-tree-row--uncat">
            <label>
              <input
                type="checkbox"
                checked={showUncategorized}
                onChange={(e) => onChangeShowUncategorized(e.target.checked)}
              />
              <span className="builder-tree-swatch builder-tree-swatch--uncat" aria-hidden />
              <span className="builder-tree-name">{t("report.uncategorized")}</span>
            </label>
          </li>
        </ul>
      )}

      <div className="builder-order">
        {nothingSelected ? (
          <p className="builder-section-empty">{t("builder.sectionEmpty")}</p>
        ) : (
          <ol className="builder-order-list">
            {selected.map((id, idx) => {
              const cat = byId.get(id);
              return (
                <li key={id} className="builder-order-row">
                  <span
                    className="builder-tree-swatch"
                    style={{ background: cat?.color ?? "#999" }}
                    aria-hidden
                  />
                  <span className="builder-order-name">{cat?.name ?? `#${id}`}</span>
                  <span className="builder-order-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => move(idx, -1)}
                      disabled={idx === 0}
                      title={t("builder.moveUp")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => move(idx, 1)}
                      disabled={idx === selected.length - 1}
                      title={t("builder.moveDown")}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => remove(id)}
                      title={t("builder.remove")}
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
            {showUncategorized && (
              <li className="builder-order-row builder-order-row--uncat">
                <span
                  className="builder-tree-swatch builder-tree-swatch--uncat"
                  aria-hidden
                />
                <span className="builder-order-name builder-order-name--uncat">
                  {t("report.uncategorized")}
                </span>
                <span className="builder-order-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onChangeShowUncategorized(false)}
                    title={t("builder.remove")}
                  >
                    ×
                  </button>
                </span>
              </li>
            )}
          </ol>
        )}
      </div>
    </div>
  );
}
