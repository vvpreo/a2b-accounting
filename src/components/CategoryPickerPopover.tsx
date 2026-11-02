import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { Category, CategoryKind, listCategories } from "../lib/api";
import { CategoryNode, buildTree, flattenTree } from "../lib/category-tree";

const POPOVER_WIDTH = 280;
const POPOVER_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 8;

interface Props {
  kind: CategoryKind;
  excludeIds: number[];
  anchorRect: DOMRect;
  onPick: (category: Category) => void;
  onClose: () => void;
  /// When provided, the popover shows a destructive "Clear categories"
  /// action above the category list. Used from the Transactions cell so
  /// the user can wipe a transaction's categorisation in one click,
  /// without opening the distribution modal first. Callers that don't
  /// need this (e.g. the distribution modal adding more categories to
  /// an existing split) just omit the prop.
  onClear?: () => void;
}

export function CategoryPickerPopover({
  kind,
  excludeIds,
  anchorRect,
  onPick,
  onClose,
  onClear,
}: Props) {
  const t = useT();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [filter, setFilter] = useState("");
  // Row chosen with the arrow keys; -1 while focus is only in the text field.
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    listCategories()
      .then((cs) => {
        if (alive) setCategories(cs);
      })
      .catch(() => {
        if (alive) setCategories([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // Capture-phase click: an outside click closes the popover AND is swallowed
    // (stopPropagation + preventDefault) so the underlying element — typically
    // another cell — does not also receive the click and open a new picker.
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const tree = useMemo<CategoryNode[]>(() => {
    if (!categories) return [];
    return buildTree(categories, kind);
  }, [categories, kind]);

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const filterLower = filter.trim().toLowerCase();

  // When filter is non-empty, flatten and filter by name.
  const flatMatches = useMemo<CategoryNode[] | null>(() => {
    if (filterLower === "") return null;
    return flattenTree(tree).filter((n) =>
      n.category.name.toLowerCase().includes(filterLower),
    );
  }, [tree, filterLower]);

  // Rows the arrows walk through, in the order they are shown.
  const selectable = useMemo(
    () => (flatMatches ?? flattenTree(tree)).map((n) => n.category).filter((c) => !excluded.has(c.id)),
    [flatMatches, tree, excluded],
  );
  const activeId = selectable[activeIndex]?.id ?? null;

  useEffect(() => {
    if (activeId === null) return;
    ref.current?.querySelector(".category-picker-row.is-active")?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (selectable.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => {
        if (i < 0) return step > 0 ? 0 : selectable.length - 1;
        return (i + step + selectable.length) % selectable.length;
      });
    } else if (e.key === "Enter") {
      // Without a chosen row, Enter takes the best match of what was typed.
      const target = selectable[activeIndex] ?? (filterLower !== "" ? selectable[0] : undefined);
      if (target) {
        e.preventDefault();
        onPick(target);
      }
    }
  }

  const style = useMemo(() => {
    const top = anchorRect.bottom + 4;
    const wouldOverflowBottom =
      top + POPOVER_MAX_HEIGHT > window.innerHeight - VIEWPORT_MARGIN;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        anchorRect.left,
        window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN,
      ),
    );
    return {
      position: "fixed" as const,
      top: wouldOverflowBottom
        ? Math.max(VIEWPORT_MARGIN, anchorRect.top - POPOVER_MAX_HEIGHT - 4)
        : top,
      left,
      width: POPOVER_WIDTH,
      maxHeight: POPOVER_MAX_HEIGHT,
    };
  }, [anchorRect]);

  function pickIfAllowed(c: Category) {
    if (excluded.has(c.id)) return;
    onPick(c);
  }

  return createPortal(
    <div
      ref={ref}
      className="category-picker-popover"
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="category-picker-search">
        <input
          autoFocus
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setActiveIndex(-1);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder={t("transactions.categories.pickerSearchPlaceholder")}
        />
      </div>
      {onClear && (
        <button
          type="button"
          className="category-picker-row category-picker-row--clear"
          onClick={onClear}
        >
          <span
            className="categories-swatch categories-swatch--clear"
            aria-hidden="true"
          />
          <span className="category-picker-name">
            {t("transactions.categories.pickerClear")}
          </span>
        </button>
      )}
      <div className="category-picker-body">
        {categories === null ? (
          <p className="hint">{t("common.loading")}</p>
        ) : tree.length === 0 ? (
          <p className="hint">
            {t(
              kind === "income"
                ? "transactions.categories.pickerEmptyIncome"
                : "transactions.categories.pickerEmptyExpense",
            )}
          </p>
        ) : flatMatches !== null ? (
          flatMatches.length === 0 ? (
            <p className="hint">{t("transactions.categories.pickerNoMatches")}</p>
          ) : (
            <ul className="category-picker-list">
              {flatMatches.map((n) => (
                <PickerItem
                  key={n.category.id}
                  node={n}
                  excluded={excluded.has(n.category.id)}
                  active={n.category.id === activeId}
                  onPick={() => pickIfAllowed(n.category)}
                />
              ))}
            </ul>
          )
        ) : (
          <ul className="category-picker-tree">
            {tree.map((n) => (
              <PickerNode
                key={n.category.id}
                node={n}
                excluded={excluded}
                activeId={activeId}
                onPick={pickIfAllowed}
              />
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PickerNode({
  node,
  excluded,
  activeId,
  onPick,
}: {
  node: CategoryNode;
  excluded: Set<number>;
  activeId: number | null;
  onPick: (c: Category) => void;
}) {
  const isExcluded = excluded.has(node.category.id);
  return (
    <li className="category-picker-node" data-depth={node.depth}>
      <button
        type="button"
        className={
          isExcluded
            ? "category-picker-row is-excluded"
            : node.category.id === activeId
              ? "category-picker-row is-active"
              : "category-picker-row"
        }
        disabled={isExcluded}
        onClick={() => onPick(node.category)}
      >
        <span
          className="categories-swatch"
          style={{ backgroundColor: node.category.color }}
          aria-hidden="true"
        />
        <span className="category-picker-name">{node.category.name}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="category-picker-tree category-picker-tree--nested">
          {node.children.map((child) => (
            <PickerNode
              key={child.category.id}
              node={child}
              excluded={excluded}
              activeId={activeId}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function PickerItem({
  node,
  excluded,
  active,
  onPick,
}: {
  node: CategoryNode;
  excluded: boolean;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <li className="category-picker-node">
      <button
        type="button"
        className={
          excluded
            ? "category-picker-row is-excluded"
            : active
              ? "category-picker-row is-active"
              : "category-picker-row"
        }
        disabled={excluded}
        onClick={onPick}
      >
        <span
          className="categories-swatch"
          style={{ backgroundColor: node.category.color }}
          aria-hidden="true"
        />
        <span className="category-picker-name">{node.category.name}</span>
      </button>
    </li>
  );
}
