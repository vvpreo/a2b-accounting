import { useMemo, useRef, useState } from "react";

import { useT } from "../../i18n";
import {
  Category,
  CategoryKind,
  TransactionCategoryView,
  setTransactionCategories,
} from "../../lib/api";
import { CategoryPickerPopover } from "../../components/CategoryPickerPopover";
import { CategoryDistributionModal } from "../../components/CategoryDistributionModal";
import {
  addEqualToCategorized,
  percentOf,
} from "../../lib/distribution";
import { formatMinorAsMoney } from "../../lib/money";

const MAX_VISIBLE_BARS = 3;

interface Props {
  transactionId: number;
  totalMinor: number;
  kind: CategoryKind;
  entries: TransactionCategoryView[]; // sorted by position
  onChanged: () => void;
}

export function CategoriesCell({
  transactionId,
  totalMinor,
  kind,
  entries,
  onChanged,
}: Props) {
  const t = useT();
  const cellRef = useRef<HTMLDivElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sumShares = entries.reduce((a, b) => a + b.shareMinor, 0);
  const uncategorized = Math.max(0, totalMinor - sumShares);
  const sortedDesc = useMemo(
    () => [...entries].sort((a, b) => b.shareMinor - a.shareMinor),
    [entries],
  );

  function openPicker() {
    if (cellRef.current) {
      setPickerAnchor(cellRef.current.getBoundingClientRect());
    }
  }

  async function handlePick(c: Category) {
    setPickerAnchor(null);
    setError(null);
    try {
      if (entries.length === 0) {
        // First pick: 100% on this category.
        await setTransactionCategories({
          transactionId,
          items: [
            { categoryId: c.id, shareMinor: totalMinor, position: 0 },
          ],
        });
      } else {
        // Subsequent: split categorized pool equally.
        const oldShares = [
          ...entries.map((e) => e.shareMinor),
          uncategorized,
        ];
        const newShares = addEqualToCategorized(oldShares, totalMinor);
        const newCats = newShares.slice(0, -1);
        const meta = [
          ...entries.map((e) => ({ categoryId: e.categoryId })),
          { categoryId: c.id },
        ];
        // Sort by descending share to compute final positions.
        const ordered = meta
          .map((m, i) => ({ m, share: newCats[i] }))
          .sort((a, b) => b.share - a.share || a.m.categoryId - b.m.categoryId);
        const items = ordered
          .map((row, idx) => ({
            categoryId: row.m.categoryId,
            shareMinor: row.share,
            position: idx,
          }))
          .filter((it) => it.shareMinor > 0);
        await setTransactionCategories({ transactionId, items });
      }
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  if (entries.length === 0) {
    return (
      <td className="txn-categories-cell-host col-category">
        <div
          ref={cellRef}
          className="txn-categories-cell txn-categories-cell--empty"
          onClick={openPicker}
        >
          <span className="txn-categories-empty-label">
            {t("transactions.categories.cellEmpty")}
          </span>
        </div>
        {pickerAnchor && (
          <CategoryPickerPopover
            kind={kind}
            excludeIds={[]}
            anchorRect={pickerAnchor}
            onPick={handlePick}
            onClose={() => setPickerAnchor(null)}
          />
        )}
        {error && <div className="txn-categories-error">{error}</div>}
      </td>
    );
  }

  // Visible entries: top MAX_VISIBLE_BARS by position; if more, fold the rest
  // into a "+N" bar whose flex equals the sum of remaining shares.
  const sortedByPosition = [...entries].sort((a, b) => a.position - b.position);
  const visible = sortedByPosition.slice(0, MAX_VISIBLE_BARS);
  const hidden = sortedByPosition.slice(MAX_VISIBLE_BARS);
  const hiddenShareSum = hidden.reduce((a, b) => a + b.shareMinor, 0);

  return (
    <td className="txn-categories-cell-host col-category">
      <div
        ref={cellRef}
        className="txn-categories-cell"
        onMouseEnter={() => setHoverOpen(true)}
        onMouseLeave={() => setHoverOpen(false)}
        onClick={(e) => {
          // Skip if click happened on the edit button (it has its own handler).
          const target = e.target as HTMLElement;
          if (target.closest(".txn-categories-edit-btn")) return;
          openPicker();
        }}
      >
        {visible.map((v) => (
          <div
            key={v.categoryId}
            className="txn-categories-bar"
            style={{ flex: v.shareMinor, backgroundColor: v.categoryColor }}
            title={`${v.categoryName} · ${formatMinorAsMoney(v.shareMinor)}`}
          >
            <span className="txn-categories-bar-label">{v.categoryName}</span>
          </div>
        ))}
        {hidden.length > 0 && (
          <div
            className="txn-categories-bar txn-categories-bar--more"
            style={{ flex: hiddenShareSum }}
            title={hidden
              .map(
                (h) => `${h.categoryName} · ${formatMinorAsMoney(h.shareMinor)}`,
              )
              .join("\n")}
          >
            <span className="txn-categories-bar-label">
              {t("transactions.categories.cellMore", { count: hidden.length })}
            </span>
          </div>
        )}
        {uncategorized > 0 && (
          <div
            className="txn-categories-bar txn-categories-bar--uncategorized"
            style={{ flex: uncategorized }}
            title={`${t("transactions.categories.cellUncategorized")} · ${formatMinorAsMoney(uncategorized)}`}
          />
        )}
        <button
          type="button"
          className="txn-categories-edit-btn"
          onClick={(e) => {
            e.stopPropagation();
            setHoverOpen(false);
            setModalOpen(true);
          }}
          aria-label={t("transactions.categories.editButton")}
        >
          ✎
        </button>

        {hoverOpen && (
          <div className="txn-categories-tooltip">
            {sortedDesc.map((e) => (
              <div key={e.categoryId} className="txn-categories-tooltip-row">
                <span
                  className="categories-swatch"
                  style={{ backgroundColor: e.categoryColor }}
                  aria-hidden="true"
                />
                <span className="txn-categories-tooltip-name">
                  {e.categoryName}
                </span>
                <span className="txn-categories-tooltip-amount">
                  {formatMinorAsMoney(e.shareMinor)}
                </span>
                <span className="txn-categories-tooltip-percent">
                  {percentOf(e.shareMinor, totalMinor).toFixed(1)}%
                </span>
              </div>
            ))}
            {uncategorized > 0 && (
              <div className="txn-categories-tooltip-row">
                <span
                  className="categories-swatch categories-swatch--uncategorized"
                  aria-hidden="true"
                />
                <span className="txn-categories-tooltip-name">
                  {t("transactions.categories.cellUncategorized")}
                </span>
                <span className="txn-categories-tooltip-amount">
                  {formatMinorAsMoney(uncategorized)}
                </span>
                <span className="txn-categories-tooltip-percent">
                  {percentOf(uncategorized, totalMinor).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {pickerAnchor && (
        <CategoryPickerPopover
          kind={kind}
          excludeIds={entries.map((e) => e.categoryId)}
          anchorRect={pickerAnchor}
          onPick={handlePick}
          onClose={() => setPickerAnchor(null)}
        />
      )}

      {modalOpen && (
        <CategoryDistributionModal
          transactionId={transactionId}
          totalMinor={totalMinor}
          kind={kind}
          initial={entries}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            setModalOpen(false);
            onChanged();
          }}
        />
      )}

      {error && <div className="txn-categories-error">{error}</div>}
    </td>
  );
}
