import React, { FormEvent, useEffect, useMemo, useState } from "react";

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
  listAccounts,
  listCategories,
  updateReportView,
} from "../lib/api";

interface Props {
  view: ReportView;
  onSaved: (view: ReportView) => void;
  onCancel: () => void;
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
    defaultRange: { kind: "preset", preset: "current_year" },
    defaultGranularity: "month",
    expandedCategoryIds: [],
  };
}

function safeParseConfig(raw: string): ReportConfig {
  try {
    const parsed = JSON.parse(raw) as Partial<ReportConfig>;
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

// Produce a flat DFS order of category ids for a single section.
// `savedOrder` (when present) provides priority ordering for siblings; any
// siblings not in `savedOrder` are appended after them in alphabetical order.
function computeInitialOrder(cats: Category[], savedOrder?: number[]): number[] {
  const byParent = new Map<number | null, Category[]>();
  for (const c of cats) {
    const key = c.parentId ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(c);
    else byParent.set(key, [c]);
  }
  const savedIdx = new Map<number, number>();
  if (savedOrder) savedOrder.forEach((id, i) => savedIdx.set(id, i));
  for (const arr of byParent.values()) {
    arr.sort((a, b) => {
      const ai = savedIdx.has(a.id) ? savedIdx.get(a.id)! : Number.POSITIVE_INFINITY;
      const bi = savedIdx.has(b.id) ? savedIdx.get(b.id)! : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
  }
  const out: number[] = [];
  function dfs(parent: number | null) {
    const kids = byParent.get(parent) ?? [];
    for (const c of kids) {
      out.push(c.id);
      dfs(c.id);
    }
  }
  dfs(null);
  return out;
}

export function ReportsBuilderPage({ view, onSaved, onCancel }: Props) {
  const t = useT();

  const [name, setName] = useState("");
  const [accountIds, setAccountIds] = useState<number[]>([]);
  const [expenseOrder, setExpenseOrder] = useState<number[]>([]);
  const [expenseSelected, setExpenseSelected] = useState<Set<number>>(new Set());
  const [incomeOrder, setIncomeOrder] = useState<number[]>([]);
  const [incomeSelected, setIncomeSelected] = useState<Set<number>>(new Set());
  const [range, setRange] = useState<ReportRange>({ kind: "preset", preset: "current_year" });
  const [granularity, setGranularity] = useState<Granularity>("month");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const initialExpandedIds = useMemo(
    () => safeParseConfig(view.config).expandedCategoryIds,
    [view.config],
  );

  useEffect(() => {
    Promise.all([listAccounts(), listCategories()])
      .then(([accs, cats]) => {
        setAccounts(accs);
        setCategories(cats);
        setLoaded(true);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Reset form whenever the editing target or the loaded category set changes.
  useEffect(() => {
    if (!loaded) return;
    const expCats = categories.filter((c) => c.kind === "expense");
    const incCats = categories.filter((c) => c.kind === "income");
    const cfg = safeParseConfig(view.config);
    setName(view.name);
    setAccountIds(cfg.accountIds);
    setExpenseOrder(
      computeInitialOrder(expCats, cfg.expenseCategoryOrder ?? cfg.expenseCategoryIds),
    );
    setExpenseSelected(new Set(cfg.expenseCategoryIds));
    setIncomeOrder(
      computeInitialOrder(incCats, cfg.incomeCategoryOrder ?? cfg.incomeCategoryIds),
    );
    setIncomeSelected(new Set(cfg.incomeCategoryIds));
    setRange(cfg.defaultRange);
    setGranularity(cfg.defaultGranularity);
    setError(null);
  }, [view, loaded, categories]);

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

    const expenseSelOrdered = expenseOrder.filter((id) => expenseSelected.has(id));
    const incomeSelOrdered = incomeOrder.filter((id) => incomeSelected.has(id));

    if (range.kind === "custom" && range.from && range.to && range.to < range.from) {
      setError(t("builder.errorBadDates"));
      return;
    }

    const config: ReportConfig = {
      version: 1,
      accountIds,
      expenseCategoryIds: expenseSelOrdered,
      incomeCategoryIds: incomeSelOrdered,
      expenseCategoryOrder: expenseOrder,
      incomeCategoryOrder: incomeOrder,
      defaultRange: range,
      defaultGranularity: granularity,
      expandedCategoryIds: initialExpandedIds,
    };
    const payload = JSON.stringify(config);

    setSubmitting(true);
    try {
      const saved = await updateReportView({
        id: view.id,
        name: name.trim(),
        config: payload,
      });
      onSaved(saved);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page builder-page">
      <header className="builder-header">
        <h2>{t("builder.titleEdit")}</h2>
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

        <div className="builder-sections">
          <CategorySection
            title={t("builder.sectionExpense")}
            kind="expense"
            categories={categories}
            order={expenseOrder}
            setOrder={setExpenseOrder}
            selected={expenseSelected}
            setSelected={setExpenseSelected}
          />
          <CategorySection
            title={t("builder.sectionIncome")}
            kind="income"
            categories={categories}
            order={incomeOrder}
            setOrder={setIncomeOrder}
            selected={incomeSelected}
            setSelected={setIncomeSelected}
          />
        </div>

        <div className="builder-actions">
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? t("builder.saving") : t("builder.save")}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </section>
  );
}

interface CategorySectionProps {
  title: string;
  kind: CategoryKind;
  categories: Category[];
  order: number[];
  setOrder: (next: number[]) => void;
  selected: Set<number>;
  setSelected: (next: Set<number>) => void;
}

interface MovePreview {
  // Row that will end up adjacent to the moved category. The green band is
  // rendered on this row's edge so the user can see where it will land.
  targetId: number;
  kind: "before" | "after";
  // Depth of the *moved* category — drives the indicator's left indent so it
  // visually starts at the level where the item will actually land (matters
  // when target sits at a different depth than the source).
  sourceDepth: number;
}

function CategorySection({
  title,
  kind,
  categories,
  order,
  setOrder,
  selected,
  setSelected,
}: CategorySectionProps) {
  const t = useT();

  const byId = useMemo(() => {
    const m = new Map<number, Category>();
    for (const c of categories) {
      if (c.kind === kind) m.set(c.id, c);
    }
    return m;
  }, [categories, kind]);

  // Defensive filter: drop ids that no longer exist (e.g. category deleted
  // since the view was saved).
  const renderedIds = useMemo(() => order.filter((id) => byId.has(id)), [order, byId]);

  function depthOf(id: number): number {
    let depth = 0;
    let cur: number | null | undefined = byId.get(id)?.parentId;
    while (cur != null) {
      depth++;
      cur = byId.get(cur)?.parentId;
    }
    return depth;
  }

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) {
      // Cascade uncheck: when a parent is unchecked, all its descendants must
      // also drop out — keeping a child selected without its parent in the
      // section would be confusing now that section totals are invariant.
      next.delete(id);
      for (const otherId of renderedIds) {
        if (otherId !== id && isDescendantOf(otherId, id)) {
          next.delete(otherId);
        }
      }
    } else {
      // No cascade on check — the user picks subcategories explicitly so the
      // visible distribution stays under their direct control.
      next.add(id);
    }
    setSelected(next);
  }

  // ---- reordering via per-row up/down arrows ----
  // Cache the rendered ids' parent ids so move boundaries can be checked in O(1).
  const siblingIndex = useMemo(() => {
    const groups = new Map<number | null, number[]>();
    for (const id of renderedIds) {
      const parent = byId.get(id)?.parentId ?? null;
      const arr = groups.get(parent);
      if (arr) arr.push(id);
      else groups.set(parent, [id]);
    }
    return groups;
  }, [renderedIds, byId]);

  function siblingNeighbour(id: number, dir: "up" | "down"): number | null {
    const parent = byId.get(id)?.parentId ?? null;
    const sibs = siblingIndex.get(parent);
    if (!sibs) return null;
    const idx = sibs.indexOf(id);
    if (idx === -1) return null;
    if (dir === "up") return idx > 0 ? sibs[idx - 1] : null;
    return idx < sibs.length - 1 ? sibs[idx + 1] : null;
  }

  function isDescendantOf(id: number, ancestor: number): boolean {
    let cur: number | null | undefined = byId.get(id)?.parentId;
    while (cur != null) {
      if (cur === ancestor) return true;
      cur = byId.get(cur)?.parentId;
    }
    return false;
  }

  // Hovered arrow → which gap to highlight green.
  const [preview, setPreview] = useState<MovePreview | null>(null);

  function previewFor(id: number, dir: "up" | "down"): MovePreview | null {
    const neighbour = siblingNeighbour(id, dir);
    if (neighbour == null) return null;
    const sourceDepth = depthOf(id);
    if (dir === "up") {
      // Lands BEFORE the previous sibling — visual goes above its row, which
      // is also the top of that sibling's subtree.
      return { targetId: neighbour, kind: "before", sourceDepth };
    }
    // Down: lands AFTER the next sibling's *whole subtree*, so the indicator
    // sits below the last descendant of that subtree (not the sibling row
    // itself).
    let last = neighbour;
    const nIdx = renderedIds.indexOf(neighbour);
    for (let i = nIdx + 1; i < renderedIds.length; i++) {
      if (isDescendantOf(renderedIds[i], neighbour)) last = renderedIds[i];
      else break;
    }
    return { targetId: last, kind: "after", sourceDepth };
  }

  function move(id: number, dir: "up" | "down") {
    const target = previewFor(id, dir);
    if (!target) return;
    const next = moveSubtree(order, byId, id, target.targetId, target.kind);
    if (next !== order) setOrder(next);
    setPreview(null);
  }

  return (
    <div className="builder-section">
      <h3 className="builder-section-title">{title}</h3>
      {renderedIds.length === 0 ? (
        <p className="builder-section-empty">{t("categories.empty")}</p>
      ) : (
        <ul className="builder-tree">
          {renderedIds.map((id) => {
            const cat = byId.get(id)!;
            const depth = depthOf(id);
            const isChecked = selected.has(id);
            const canUp = siblingNeighbour(id, "up") != null;
            const canDown = siblingNeighbour(id, "down") != null;
            const isPreviewTarget = preview?.targetId === id;
            const previewClass = isPreviewTarget
              ? preview!.kind === "before"
                ? " builder-tree-row--preview-before"
                : " builder-tree-row--preview-after"
              : "";
            const indicatorIndent = isPreviewTarget
              ? 8 + preview!.sourceDepth * 18
              : 8 + depth * 18;
            return (
              <li
                key={id}
                className={`builder-tree-row${previewClass}`}
                style={
                  {
                    paddingLeft: `${8 + depth * 18}px`,
                    "--row-indent": `${indicatorIndent}px`,
                  } as React.CSSProperties
                }
              >
                <label>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(id)}
                  />
                  <span
                    className="builder-tree-swatch"
                    style={{ background: cat.color }}
                    aria-hidden
                  />
                  <span className="builder-tree-name">{cat.name}</span>
                </label>
                <span className="builder-tree-actions">
                  {canUp && (
                    <button
                      type="button"
                      className="icon-btn builder-tree-arrow"
                      title={t("builder.moveUp")}
                      aria-label={t("builder.moveUp")}
                      onMouseEnter={() => setPreview(previewFor(id, "up"))}
                      onMouseLeave={() => setPreview(null)}
                      onFocus={() => setPreview(previewFor(id, "up"))}
                      onBlur={() => setPreview(null)}
                      onClick={() => move(id, "up")}
                    >
                      ▲
                    </button>
                  )}
                  {canDown && (
                    <button
                      type="button"
                      className="icon-btn builder-tree-arrow"
                      title={t("builder.moveDown")}
                      aria-label={t("builder.moveDown")}
                      onMouseEnter={() => setPreview(previewFor(id, "down"))}
                      onMouseLeave={() => setPreview(null)}
                      onFocus={() => setPreview(previewFor(id, "down"))}
                      onBlur={() => setPreview(null)}
                      onClick={() => move(id, "down")}
                    >
                      ▼
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Move a category (and its subtree) within its sibling group, before/after a
// target sibling. Returns a new flat-DFS order array.
function moveSubtree(
  order: number[],
  byId: Map<number, Category>,
  draggedId: number,
  targetId: number,
  position: "before" | "after",
): number[] {
  const draggedStart = order.indexOf(draggedId);
  if (draggedStart === -1) return order;

  function isDescendantOf(id: number, ancestor: number): boolean {
    let cur: number | null | undefined = byId.get(id)?.parentId;
    while (cur != null) {
      if (cur === ancestor) return true;
      cur = byId.get(cur)?.parentId;
    }
    return false;
  }

  let draggedEnd = draggedStart + 1;
  while (draggedEnd < order.length && isDescendantOf(order[draggedEnd], draggedId)) {
    draggedEnd++;
  }
  const subtree = order.slice(draggedStart, draggedEnd);
  const without = [...order.slice(0, draggedStart), ...order.slice(draggedEnd)];

  const targetIdx = without.indexOf(targetId);
  if (targetIdx === -1) return order;

  let insertAt: number;
  if (position === "before") {
    insertAt = targetIdx;
  } else {
    let targetEnd = targetIdx + 1;
    while (
      targetEnd < without.length &&
      isDescendantOf(without[targetEnd], targetId)
    ) {
      targetEnd++;
    }
    insertAt = targetEnd;
  }

  return [...without.slice(0, insertAt), ...subtree, ...without.slice(insertAt)];
}
