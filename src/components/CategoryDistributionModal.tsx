import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import {
  Category,
  CategoryKind,
  TransactionCategoryItem,
  TransactionCategoryView,
  setTransactionCategories,
} from "../lib/api";
import {
  addEqualToCategorized,
  percentOf,
  removeAt,
  setShareAt,
  setUncategorized,
} from "../lib/distribution";
import { formatMinorAsMoney, parseMoneyToMinor } from "../lib/money";
import { CategoryPickerPopover } from "./CategoryPickerPopover";

interface Entry {
  categoryId: number;
  name: string;
  color: string;
}

interface Props {
  transactionId: number;
  totalMinor: number;
  kind: CategoryKind;
  initial: TransactionCategoryView[];
  onClose: () => void;
  onSaved: () => void;
}

export function CategoryDistributionModal({
  transactionId,
  totalMinor,
  kind,
  initial,
  onClose,
  onSaved,
}: Props) {
  const t = useT();

  // Parallel arrays: entries[i] meta, shares[i] kopecks. shares.length == entries.length + 1
  // (last is the uncategorized residual).
  const [entries, setEntries] = useState<Entry[]>(() =>
    initial.map((e) => ({
      categoryId: e.categoryId,
      name: e.categoryName,
      color: e.categoryColor,
    })),
  );
  const [shares, setShares] = useState<number[]>(() => {
    const cats = initial.map((e) => e.shareMinor);
    const sum = cats.reduce((a, b) => a + b, 0);
    return [...cats, Math.max(0, totalMinor - sum)];
  });

  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cumLeft = useMemo(() => {
    const cum: number[] = [];
    let acc = 0;
    for (let i = 0; i < entries.length; i += 1) {
      cum.push(acc);
      acc += shares[i];
    }
    return cum;
  }, [entries.length, shares]);

  function handleSliderChange(idx: number, newValue: number) {
    setShares((prev) => setShareAt(prev, idx, newValue, totalMinor));
  }

  function handlePercentInput(idx: number, percent: number) {
    // Percent is always relative to the transaction total — mirrors the
    // displayed input value. setShareAt clamps to the per-slider remainder.
    const newValue = Math.round((percent / 100) * totalMinor);
    handleSliderChange(idx, newValue);
  }

  function handleSumInput(idx: number, raw: string) {
    const parsed = parseMoneyToMinor(raw);
    if (parsed === null) return;
    handleSliderChange(idx, parsed);
  }

  function handleUncategorizedSum(raw: string) {
    const parsed = parseMoneyToMinor(raw);
    if (parsed === null) return;
    setShares((prev) => setUncategorized(prev, parsed, totalMinor));
  }

  function handleUncategorizedPercent(percent: number) {
    const newValue = Math.round((percent / 100) * totalMinor);
    setShares((prev) => setUncategorized(prev, newValue, totalMinor));
  }

  function moveEntry(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= entries.length) return;
    setEntries((prev) => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    setShares((prev) => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function removeEntry(idx: number) {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
    setShares((prev) => removeAt(prev, idx, totalMinor));
  }

  function openPicker() {
    if (addBtnRef.current) {
      setPickerAnchor(addBtnRef.current.getBoundingClientRect());
    }
  }

  function handlePick(c: Category) {
    setPickerAnchor(null);
    setEntries((prev) => [
      ...prev,
      { categoryId: c.id, name: c.name, color: c.color },
    ]);
    setShares((prev) => addEqualToCategorized(prev, totalMinor));
  }

  async function handleSave() {
    setError(null);
    setSubmitting(true);
    try {
      const items: TransactionCategoryItem[] = entries
        .map((e, i) => ({
          categoryId: e.categoryId,
          shareMinor: shares[i],
          position: i,
        }))
        .filter((it) => it.shareMinor > 0);
      await setTransactionCategories({ transactionId, items });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const uncatShare = shares[shares.length - 1] ?? totalMinor;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--distribution"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3>{t("transactions.categories.modalTitle")}</h3>
          <span className="distribution-modal-total">
            {t("transactions.categories.modalTotal")}:{" "}
            <strong>{formatMinorAsMoney(totalMinor)}</strong>
          </span>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="modal-body distribution-modal-body">
          <ul className="distribution-list">
            {entries.map((e, i) => (
              <li key={e.categoryId} className="distribution-row">
                <div className="distribution-reorder">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => moveEntry(i, -1)}
                    disabled={i === 0}
                    aria-label={t("transactions.categories.modalMoveUp")}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => moveEntry(i, 1)}
                    disabled={i === entries.length - 1}
                    aria-label={t("transactions.categories.modalMoveDown")}
                  >
                    ↓
                  </button>
                </div>
                <span
                  className="categories-swatch"
                  style={{ backgroundColor: e.color }}
                  aria-hidden="true"
                />
                <span className="distribution-name">{e.name}</span>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => removeEntry(i)}
                  aria-label={t("transactions.categories.modalRemove")}
                >
                  ×
                </button>
              </li>
            ))}
            <li className="distribution-row distribution-row--uncategorized">
              <div className="distribution-reorder distribution-reorder--placeholder" />
              <span
                className="categories-swatch categories-swatch--uncategorized"
                aria-hidden="true"
              />
              <span className="distribution-name">
                {t("transactions.categories.modalUncategorized")}
              </span>
            </li>
          </ul>

          <button
            ref={addBtnRef}
            type="button"
            className="btn-ghost"
            onClick={openPicker}
          >
            {t("transactions.categories.modalAddCategory")}
          </button>

          {entries.length > 0 && (
            <>
              <h4 className="distribution-section-title">
                {t("transactions.categories.modalDistribution")}
              </h4>
              <div className="distribution-sliders">
                {entries.map((e, i) => {
                  const remainderBudget = totalMinor - cumLeft[i];
                  return (
                    <SliderRow
                      key={e.categoryId}
                      name={e.name}
                      color={e.color}
                      share={shares[i]}
                      remainderBudget={remainderBudget}
                      total={totalMinor}
                      onSlide={(v) => handleSliderChange(i, v)}
                      onPercent={(p) => handlePercentInput(i, p)}
                      onSum={(s) => handleSumInput(i, s)}
                    />
                  );
                })}
                <UncategorizedRow
                  share={uncatShare}
                  total={totalMinor}
                  onPercent={handleUncategorizedPercent}
                  onSum={handleUncategorizedSum}
                  uncategorizedLabel={t(
                    "transactions.categories.modalUncategorized",
                  )}
                />
              </div>
            </>
          )}

          {error && <div className="error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSave}
            disabled={submitting}
          >
            {submitting ? t("common.saving") : t("common.save")}
          </button>
        </footer>
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
    </div>,
    document.body,
  );
}

function SliderRow({
  name,
  color,
  share,
  remainderBudget,
  total,
  onSlide,
  onPercent,
  onSum,
}: {
  name: string;
  color: string;
  share: number;
  remainderBudget: number;
  total: number;
  onSlide: (v: number) => void;
  onPercent: (p: number) => void;
  onSum: (s: string) => void;
}) {
  const [sumInput, setSumInput] = useState(formatMinorAsMoney(share));
  const [percentInput, setPercentInput] = useState(
    percentOf(share, total).toString(),
  );

  // Sync local inputs when share changes externally (e.g. another slider moved).
  const lastShareRef = useRef(share);
  if (lastShareRef.current !== share) {
    lastShareRef.current = share;
    setSumInput(formatMinorAsMoney(share));
    setPercentInput(percentOf(share, total).toString());
  }

  return (
    <div className="distribution-slider">
      <div className="distribution-slider-header">
        <span
          className="categories-swatch"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="distribution-slider-name">{name}</span>
      </div>
      <div className="distribution-scale-top">
        <span>0%</span>
        <span>{percentOf(remainderBudget, total).toFixed(1)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={remainderBudget}
        step={1}
        value={Math.min(share, remainderBudget)}
        onChange={(e) => onSlide(parseInt(e.target.value, 10))}
        className="distribution-range"
      />
      <div className="distribution-scale-bottom">
        <span>0</span>
        <span>{formatMinorAsMoney(remainderBudget)}</span>
      </div>
      <div className="distribution-inputs">
        <label>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={percentInput}
            onChange={(e) => setPercentInput(e.target.value)}
            onBlur={(e) => {
              const p = parseFloat(e.target.value);
              if (!Number.isNaN(p)) onPercent(p);
            }}
          />
          <span>%</span>
        </label>
        <label>
          <input
            type="text"
            inputMode="decimal"
            value={sumInput}
            onChange={(e) => setSumInput(e.target.value)}
            onBlur={(e) => onSum(e.target.value)}
          />
          <span>₽</span>
        </label>
      </div>
    </div>
  );
}

function UncategorizedRow({
  share,
  total,
  onPercent,
  onSum,
  uncategorizedLabel,
}: {
  share: number;
  total: number;
  onPercent: (p: number) => void;
  onSum: (s: string) => void;
  uncategorizedLabel: string;
}) {
  const [sumInput, setSumInput] = useState(formatMinorAsMoney(share));
  const [percentInput, setPercentInput] = useState(
    percentOf(share, total).toString(),
  );
  const lastShareRef = useRef(share);
  if (lastShareRef.current !== share) {
    lastShareRef.current = share;
    setSumInput(formatMinorAsMoney(share));
    setPercentInput(percentOf(share, total).toString());
  }
  return (
    <div className="distribution-slider distribution-slider--uncategorized">
      <div className="distribution-slider-header">
        <span
          className="categories-swatch categories-swatch--uncategorized"
          aria-hidden="true"
        />
        <span className="distribution-slider-name">{uncategorizedLabel}</span>
      </div>
      <div className="distribution-inputs">
        <label>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={percentInput}
            onChange={(e) => setPercentInput(e.target.value)}
            onBlur={(e) => {
              const p = parseFloat(e.target.value);
              if (!Number.isNaN(p)) onPercent(p);
            }}
          />
          <span>%</span>
        </label>
        <label>
          <input
            type="text"
            inputMode="decimal"
            value={sumInput}
            onChange={(e) => setSumInput(e.target.value)}
            onBlur={(e) => onSum(e.target.value)}
          />
          <span>₽</span>
        </label>
      </div>
    </div>
  );
}
