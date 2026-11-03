import { CSSProperties, KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { indexAfterKey, indexByTyping } from "../lib/select-navigation";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}

const LIST_MAX_HEIGHT = 320;
const VIEWPORT_MARGIN = 8;
const TYPING_RESET_MS = 700;

/// A single-choice list in the app's own look, in place of the native `<select>`
/// popup of the OS. Focus stays on the button; the list is portalled, so a
/// scrolling modal does not clip it.
export function SelectDropdown({ value, options, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const label = selectedIndex >= 0 ? options[selectedIndex].label : value;

  function show() {
    setActive(Math.max(selectedIndex, 0));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
  }

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const above = rect.top - VIEWPORT_MARGIN;
    const fitsBelow = below >= Math.min(LIST_MAX_HEIGHT, listRef.current?.scrollHeight ?? 0) || below >= above;
    setStyle({
      position: "fixed",
      visibility: "visible",
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(LIST_MAX_HEIGHT, (fitsBelow ? below : above) - 4),
      ...(fitsBelow ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
    });
  }, [open]);

  useEffect(() => {
    // Only the list scrolls: moving the page would close it.
    const list = listRef.current;
    const option = list?.children[active] as HTMLElement | undefined;
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [open, active, style]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as Node;
      if (listRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeNow = () => setOpen(false);
    document.addEventListener("mousedown", close);
    // The list stands where the button was: it goes when the page moves.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", closeNow);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", closeNow);
    };
  }, [open]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const typing = Date.now() - typed.current.at < TYPING_RESET_MS;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      // Closes the list, not the window it is in.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (e.key === "Enter" || (e.key === " " && !typing)) {
      e.preventDefault();
      choose(active);
      return;
    }
    const next = indexAfterKey(e.key, active, options.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const text = (typing ? typed.current.text : "") + e.key;
      typed.current = { text, at: Date.now() };
      const found = indexByTyping(options.map((o) => o.label), text, active);
      if (found !== null) setActive(found);
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`select-dropdown${open ? " is-open" : ""}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="select-dropdown-label">{label}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={`${id}-list`}
            className="select-dropdown-list"
            role="listbox"
            style={style}
            // Keeps the focus on the button.
            onMouseDown={(e) => e.preventDefault()}
            // React events bubble through portals: not to the label or the window.
            onClick={(e) => e.stopPropagation()}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={o.value === value}
                className={`select-dropdown-option${i === active ? " is-active" : ""}${o.value === value ? " is-selected" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                {o.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
