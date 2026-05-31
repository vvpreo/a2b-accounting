import { useRef } from "react";

/// Long-press threshold. The spec asks for "more than 1 second" of hold to
/// trigger a range selection; a short tap toggles the single row. Kept as a
/// named constant so it's easy to tune for touch devices later.
const LONG_PRESS_MS = 1000;

interface Props {
  selected: boolean;
  /// Fired on a short tap/click (held < LONG_PRESS_MS).
  onShortPress: () => void;
  /// Fired once the press crosses LONG_PRESS_MS, while the pointer is still
  /// down — gives the user immediate feedback that the range was selected.
  onLongPress: () => void;
  ariaLabel?: string;
}

/// A custom checkbox (not a native <input>) so we own the full pointer
/// lifecycle and can distinguish a short tap from a long hold. Pointer events
/// unify mouse and touch, which matters for the planned tablet build.
export function SelectCheckbox({
  selected,
  onShortPress,
  onLongPress,
  ariaLabel,
}: Props) {
  const timerRef = useRef<number | null>(null);
  // Set when the long-press timer fires so the trailing pointerup is not also
  // treated as a short tap.
  const didLongRef = useRef(false);

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    // Only react to the primary button / touch contact.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    didLongRef.current = false;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      didLongRef.current = true;
      timerRef.current = null;
      onLongPress();
    }, LONG_PRESS_MS);
  }

  function onPointerUp() {
    const wasLong = didLongRef.current;
    clearTimer();
    if (wasLong) {
      didLongRef.current = false;
      return; // range already applied by the timer
    }
    onShortPress();
  }

  function onPointerLeaveOrCancel() {
    // Abandon the gesture: neither a completed long-press nor a tap.
    clearTimer();
    didLongRef.current = false;
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={ariaLabel}
      className={`txn-select-checkbox${selected ? " is-checked" : ""}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeaveOrCancel}
      onPointerCancel={onPointerLeaveOrCancel}
      // Suppress the synthetic click so it can't double-fire the toggle.
      onClick={(e) => e.preventDefault()}
    >
      {selected ? "✓" : ""}
    </button>
  );
}
