/// Pure helpers for the transactions bulk-selection feature. Kept free of React
/// so the range logic can be unit-tested in isolation.

/// Given the ids of the currently visible rows *in display order*, return the
/// inclusive range of ids between `anchorId` (the previously selected row) and
/// `targetId` (the long-pressed row). Order of the two endpoints does not
/// matter — the range is taken along `orderedIds`.
///
/// Degenerate cases collapse to "just the target": when there is no anchor yet,
/// or either endpoint is no longer in the visible list (e.g. filters changed),
/// a long press behaves like selecting the single pressed row.
export function rangeIds(
  orderedIds: number[],
  anchorId: number | null,
  targetId: number,
): number[] {
  const targetIdx = orderedIds.indexOf(targetId);
  if (targetIdx === -1) return [];
  if (anchorId === null) return [targetId];
  const anchorIdx = orderedIds.indexOf(anchorId);
  if (anchorIdx === -1) return [targetId];
  const from = Math.min(anchorIdx, targetIdx);
  const to = Math.max(anchorIdx, targetIdx);
  return orderedIds.slice(from, to + 1);
}
