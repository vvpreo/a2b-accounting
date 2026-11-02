import { RefObject, useLayoutEffect } from "react";

export function monthStartMs(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function nextMonthStartMs(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/// How far the month under the viewport's bottom edge is filled.
///
/// The edge sits `progress` (0..1) of the way through a row dated `time`, and
/// the fill is that moment's place in the calendar month, interpolated towards
/// the next row so it moves smoothly. Passing the month's last row closes the
/// month even when its transactions stop mid-month: `to` becomes the month's
/// end if a later month follows (`nextTime` outside this month) or, for the
/// very last row, if the calendar month is already over. The current month
/// stays at its last transaction's date.
export function monthFillAt(
  time: number,
  nextTime: number | null,
  progress: number,
  now: number,
): { month: number; fill: number } {
  const month = monthStartMs(time);
  const end = nextMonthStartMs(time);
  let to: number;
  if (nextTime === null) {
    to = now >= end ? end : time;
  } else {
    to = nextTime < end ? nextTime : end;
  }
  const at = time + (to - time) * progress;
  return { month, fill: (at - month) / (end - month) };
}

function paintMonthFill(wrap: HTMLElement) {
  const tbody = wrap.querySelector("tbody");
  if (!tbody) return;
  // The fill spans what is visible, not the whole (possibly wider) table; the
  // table can also end before the screen does once columns have fixed widths.
  const tableWidth = tbody.parentElement!.offsetWidth;
  wrap.style.setProperty("--view-left", `${wrap.scrollLeft}px`);
  wrap.style.setProperty("--view-width", `${Math.min(wrap.clientWidth, tableWidth)}px`);

  const rows = tbody.rows;
  // Dated rows only: skips the tail spacer and the "empty" placeholder.
  let count = rows.length;
  while (count > 0 && rows[count - 1].dataset.ts === undefined) count--;

  const edge =
    wrap.getBoundingClientRect().top + wrap.clientTop + wrap.clientHeight;
  let at = -1;
  for (let lo = 0, hi = count - 1; lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().top < edge) {
      at = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let current: { month: number; fill: number } | null = null;
  if (at >= 0) {
    const rect = rows[at].getBoundingClientRect();
    const progress =
      rect.height > 0
        ? Math.min(1, Math.max(0, (edge - rect.top) / rect.height))
        : 1;
    current = monthFillAt(
      Number(rows[at].dataset.ts),
      at + 1 < count ? Number(rows[at + 1].dataset.ts) : null,
      progress,
      Date.now(),
    );
  }

  // Months above the edge are closed, months below it have not started.
  const separators = tbody.getElementsByClassName("month-separator");
  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i] as HTMLElement;
    const start = Number(sep.dataset.ts);
    let fill = 0;
    if (current && start < current.month) fill = 1;
    else if (current && start === current.month) fill = current.fill;
    const value = fill.toFixed(4);
    if (sep.style.getPropertyValue("--month-fill") !== value) {
      sep.style.setProperty("--month-fill", value);
    }
  }
}

/// Keeps `--month-fill` on each `.month-separator` row in sync with scrolling.
/// Writes straight to the DOM: re-rendering the table on every scroll event
/// would be far too slow, and React leaves properties it doesn't own alone.
export function useMonthFill(
  wrapRef: RefObject<HTMLElement | null>,
  rowsKey: unknown,
) {
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => paintMonthFill(wrap);
    update();
    wrap.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    const table = wrap.querySelector("table");
    if (table) ro.observe(table);
    return () => {
      wrap.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [wrapRef, rowsKey]);
}
