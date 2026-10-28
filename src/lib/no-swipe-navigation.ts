/** The app behaves like a desktop app: a two-finger horizontal trackpad swipe
 *  never navigates the browser back / forward, on any screen.
 *
 *  CSS (`overscroll-behavior-x: none` on the root, App.css) covers Chromium;
 *  this wheel handler covers the rest. A horizontal wheel event is cancelled
 *  unless some element under the pointer can still scroll that way — tables
 *  and the month strips keep scrolling sideways, they just stop at the edge
 *  instead of handing the gesture to the browser. */

function canScrollX(el: Element, dx: number): boolean {
  if (el.scrollWidth <= el.clientWidth) return false;
  const overflowX = getComputedStyle(el).overflowX;
  if (overflowX !== "auto" && overflowX !== "scroll") return false;
  return dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

export function preventSwipeNavigation(): void {
  window.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      for (let el = e.target instanceof Element ? e.target : null; el; el = el.parentElement) {
        if (canScrollX(el, e.deltaX)) return;
      }
      e.preventDefault();
    },
    { passive: false },
  );
}
