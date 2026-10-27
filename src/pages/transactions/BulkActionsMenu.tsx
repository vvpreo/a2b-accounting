import { useEffect, useRef, useState } from "react";

import { useT } from "../../i18n";

interface Props {
  /// Number of currently selected transactions. Actions that operate on a
  /// selection are disabled (with a hint) when this is 0 — the spec forbids
  /// running a bulk action against an implicit "everything" set.
  selectedCount: number;
  /// Not a bulk action — always enabled; listed last.
  onImportTransactions: () => void;
  onAnalyzeDocuments: () => void;
  onProposeCategories: () => void;
  onAssignCategory: () => void;
}

/// Always-visible "Actions ▾" dropdown for the transactions section. Mirrors
/// the outside-click / Escape behaviour of the filter dropdowns. Bulk actions
/// on the selection, in pipeline order — match documents (slips), propose
/// categories (AI), assign a category — then "Import transactions", which
/// needs no selection.
export function BulkActionsMenu({
  selectedCount,
  onImportTransactions,
  onAnalyzeDocuments,
  onProposeCategories,
  onAssignCategory,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasSelection = selectedCount > 0;

  return (
    <div className="bulk-actions-menu" ref={rootRef}>
      <button
        type="button"
        className="btn-secondary bulk-actions-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {hasSelection
          ? t("transactions.bulk.actionsWithCount", { count: selectedCount })
          : t("transactions.bulk.actions")}
        <span className="bulk-actions-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="bulk-actions-popover" role="menu">
          {[
            { label: t("transactions.bulk.analyzeDocuments"), run: onAnalyzeDocuments },
            { label: t("transactions.bulk.proposeCategories"), run: onProposeCategories },
            { label: t("transactions.bulk.assignCategory"), run: onAssignCategory },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="bulk-actions-item"
              disabled={!hasSelection}
              title={hasSelection ? undefined : t("transactions.bulk.selectFirstHint")}
              onClick={() => {
                if (!hasSelection) return;
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
          {!hasSelection && (
            <p className="bulk-actions-hint">
              {t("transactions.bulk.selectFirstHint")}
            </p>
          )}
          <div className="dropdown-divider" />
          <button
            type="button"
            role="menuitem"
            className="bulk-actions-item"
            onClick={() => {
              setOpen(false);
              onImportTransactions();
            }}
          >
            {t("toolbar.importTransactions")}
          </button>
        </div>
      )}
    </div>
  );
}
