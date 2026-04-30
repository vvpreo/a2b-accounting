import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../i18n";
import { Category, CategoryKind } from "../../lib/api";

// Produce a flat DFS order of category ids for a single section.
// `savedOrder` (when present) provides priority ordering for siblings; any
// siblings not in `savedOrder` are appended after them in alphabetical order.
export function computeInitialOrder(cats: Category[], savedOrder?: number[]): number[] {
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

export function CategorySection({
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

export interface CategoriesPickerSelection {
  expenseOrder: number[];
  expenseSelected: Set<number>;
  incomeOrder: number[];
  incomeSelected: Set<number>;
}

interface CategoriesPickerModalProps {
  title: string;
  expenseTitle: string;
  incomeTitle: string;
  categories: Category[];
  initial: CategoriesPickerSelection;
  onCancel: () => void;
  onSave: (next: CategoriesPickerSelection) => void;
}

// Single modal that hosts both the expense and income pickers side-by-side.
// All four pieces of state (orders + selected sets for each kind) live
// locally so edits are discardable — only "Save" propagates them upstream,
// which triggers the parent's autosave path.
export function CategoriesPickerModal({
  title,
  expenseTitle,
  incomeTitle,
  categories,
  initial,
  onCancel,
  onSave,
}: CategoriesPickerModalProps) {
  const t = useT();
  const [expenseOrder, setExpenseOrder] = useState<number[]>(initial.expenseOrder);
  const [expenseSelected, setExpenseSelected] = useState<Set<number>>(
    new Set(initial.expenseSelected),
  );
  const [incomeOrder, setIncomeOrder] = useState<number[]>(initial.incomeOrder);
  const [incomeSelected, setIncomeSelected] = useState<Set<number>>(
    new Set(initial.incomeSelected),
  );

  // ESC closes the modal as a no-op (same as Cancel).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal categories-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3>{title}</h3>
          <button
            className="icon-btn"
            onClick={onCancel}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="modal-body categories-picker-modal-body">
          <div className="categories-picker-grid">
            <CategorySection
              title={expenseTitle}
              kind="expense"
              categories={categories}
              order={expenseOrder}
              setOrder={setExpenseOrder}
              selected={expenseSelected}
              setSelected={setExpenseSelected}
            />
            <CategorySection
              title={incomeTitle}
              kind="income"
              categories={categories}
              order={incomeOrder}
              setOrder={setIncomeOrder}
              selected={incomeSelected}
              setSelected={setIncomeSelected}
            />
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              onSave({
                expenseOrder,
                expenseSelected,
                incomeOrder,
                incomeSelected,
              })
            }
          >
            {t("common.save")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
