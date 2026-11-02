import { useEffect, useState } from "react";

import { SuggestionKind, dismissedSuggestionCounts } from "./api";

/** How many of these transactions have a dismissed suggestion of `kind` —
 *  for the "run the dismissed ones again" option of the run dialogs. */
export function useDismissedCount(transactionIds: number[], kind: SuggestionKind): number {
  const [count, setCount] = useState(0);
  const key = transactionIds.join(",");
  useEffect(() => {
    let cancelled = false;
    dismissedSuggestionCounts(key ? key.split(",").map(Number) : [])
      .then((c) => !cancelled && setCount(c[kind] ?? 0))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, kind]);
  return count;
}
