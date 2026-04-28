import { useEffect, useRef, useState } from "react";

export interface MultiSelectItem<T extends string | number> {
  id: T;
  label: string;
}

interface Props<T extends string | number> {
  items: MultiSelectItem<T>[];
  /** Explicit selection. Empty array means "nothing selected" (no rows match). */
  selected: T[];
  onApply: (ids: T[]) => void;
  allLabel: string;
  noneLabel: string;
  emptyItemsLabel: string;
  multiSelectedLabel: (count: number) => string;
  applyLabel: string;
}

export function MultiSelectDropdown<T extends string | number>({
  items,
  selected,
  onApply,
  allLabel,
  noneLabel,
  emptyItemsLabel,
  multiSelectedLabel,
  applyLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<T[]>(selected);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Sync pending with the latest committed selection whenever the dropdown
  // is closed — opening always starts from the applied state.
  useEffect(() => {
    if (!open) setPending(selected);
  }, [selected, open]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        // Closing without Apply — discard pending changes.
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  let summary: string;
  if (items.length === 0) {
    summary = emptyItemsLabel;
  } else if (selected.length === 0) {
    summary = noneLabel;
  } else if (selected.length === items.length) {
    summary = allLabel;
  } else if (selected.length === 1) {
    const found = items.find((i) => i.id === selected[0]);
    summary = found ? found.label : multiSelectedLabel(1);
  } else {
    summary = multiSelectedLabel(selected.length);
  }

  const allChecked =
    items.length > 0 && pending.length === items.length;

  function toggleAll() {
    if (allChecked) {
      setPending([]);
    } else {
      setPending(items.map((i) => i.id));
    }
  }

  function toggle(id: T) {
    setPending((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id],
    );
  }

  function apply() {
    onApply(pending);
    setOpen(false);
  }

  return (
    <div className="dropdown" ref={wrapRef}>
      <button
        type="button"
        className="dropdown-button"
        onClick={() => setOpen((v) => !v)}
        disabled={items.length === 0}
      >
        <span className="dropdown-button-text">{summary}</span>
      </button>
      {open && (
        <div className="dropdown-panel">
          <label className="dropdown-item">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
            />
            <span>{allLabel}</span>
          </label>
          <div className="dropdown-divider" />
          <div className="dropdown-list">
            {items.map((item) => (
              <label key={String(item.id)} className="dropdown-item">
                <input
                  type="checkbox"
                  checked={pending.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
          <div className="dropdown-divider" />
          <div className="dropdown-actions">
            <button
              type="button"
              className="btn-primary dropdown-apply"
              onClick={apply}
            >
              {applyLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
