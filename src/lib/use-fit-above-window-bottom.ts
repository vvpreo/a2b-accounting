import { useLayoutEffect, useState, type RefObject } from "react";

/** Gap kept between an open panel and the bottom of the window. */
const PANEL_BOTTOM_GAP_PX = 16;
/** The scrolling area never shrinks below this, even in a very short window. */
const MIN_HEIGHT_PX = 120;

/**
 * Max height for the scrolling part of an open dropdown panel: everything is
 * shown as long as the panel fits above the window's bottom, and only past
 * that point does it start to scroll. `scroller` may be the panel itself.
 */
export function useFitAboveWindowBottom(
  open: boolean,
  panel: RefObject<HTMLElement | null>,
  scroller: RefObject<HTMLElement | null>,
): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number>();

  useLayoutEffect(() => {
    if (!open) return;
    function fit() {
      if (!panel.current || !scroller.current) return;
      const area = scroller.current.getBoundingClientRect();
      const below = panel.current.getBoundingClientRect().bottom - area.bottom;
      setMaxHeight(
        Math.max(
          MIN_HEIGHT_PX,
          window.innerHeight - area.top - below - PANEL_BOTTOM_GAP_PX,
        ),
      );
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, panel, scroller]);

  return maxHeight;
}
