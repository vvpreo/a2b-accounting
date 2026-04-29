// Pure helpers for splitting a transaction total across category shares.
//
// Convention: every shares array has length `n + 1`, where positions 0..n-1 are
// real categories and the LAST position is the virtual "Без категории" residual.
// All values are integer kopecks (minor units). The sum of every helper's output
// equals the supplied `total`.

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// Scale `values` so they sum to `targetSum`, preserving proportions when the
// current sum is non-zero. When the input is all zeros (or empty), splits the
// target evenly. Distributes the kopeck remainder to entries with the largest
// fractional remainders, breaking ties by index.
function scaleToTarget(values: number[], targetSum: number): number[] {
  if (values.length === 0) return [];
  if (targetSum <= 0) return new Array(values.length).fill(0);

  const currentSum = values.reduce((a, b) => a + b, 0);
  if (currentSum === 0) {
    const base = Math.floor(targetSum / values.length);
    let remainder = targetSum - base * values.length;
    const result = new Array(values.length).fill(base);
    for (let i = 0; remainder > 0 && i < result.length; i += 1) {
      result[i] += 1;
      remainder -= 1;
    }
    return result;
  }

  const floats = values.map((v) => (v * targetSum) / currentSum);
  const floors = floats.map((f) => Math.floor(f));
  let remainder = targetSum - floors.reduce((a, b) => a + b, 0);
  const order = floats
    .map((f, i) => ({ i, frac: f - Math.floor(f) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = [...floors];
  let k = 0;
  while (remainder > 0 && k < order.length) {
    result[order[k].i] += 1;
    remainder -= 1;
    k += 1;
  }
  return result;
}

// Equal split among `n` categories with uncategorized = 0. Remainder kopecks
// go to the last category (not to uncategorized).
export function equalSplit(total: number, n: number): number[] {
  const shares = new Array(n + 1).fill(0);
  if (n === 0) {
    shares[0] = total;
    return shares;
  }
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  for (let i = 0; i < n; i += 1) {
    shares[i] = base;
  }
  shares[n - 1] += remainder;
  return shares;
}

// Add a new category. The categorized pool (sum of existing categories) is
// split evenly among `n + 1` categories; uncategorized stays put. Designed for
// cases where there is already at least one category.
export function addEqualToCategorized(
  shares: number[],
  _total: number,
): number[] {
  const cats = shares.slice(0, -1);
  const uncat = shares[shares.length - 1] ?? 0;
  const categorizedSum = cats.reduce((a, b) => a + b, 0);
  const newCount = cats.length + 1;
  const seed = new Array(newCount).fill(1);
  const newCats = scaleToTarget(seed, categorizedSum);
  return [...newCats, uncat];
}

// Remove the category at `idx`; its share is added to uncategorized.
export function removeAt(
  shares: number[],
  idx: number,
  _total: number,
): number[] {
  const result = shares.filter((_, i) => i !== idx);
  if (result.length === 0) return result;
  result[result.length - 1] += shares[idx];
  return result;
}

// Set share at category index `idx` to `newValue` (clamped to the available
// budget after categories left of `idx`). The right tail (categories > idx and
// uncategorized) is scaled proportionally. If the tail was all zero, the
// remainder is parked in uncategorized per the agreed UX rule.
export function setShareAt(
  shares: number[],
  idx: number,
  newValue: number,
  total: number,
): number[] {
  const result = [...shares];
  const fixedLeft = result.slice(0, idx).reduce((a, b) => a + b, 0);
  const remainderBudget = total - fixedLeft;
  const clamped = clamp(newValue, 0, remainderBudget);
  result[idx] = clamped;
  const tailTarget = remainderBudget - clamped;
  const tail = result.slice(idx + 1);
  const tailOldSum = tail.reduce((a, b) => a + b, 0);

  let scaledTail: number[];
  if (tailOldSum === 0 && tail.length > 0) {
    scaledTail = new Array(tail.length).fill(0);
    scaledTail[scaledTail.length - 1] = tailTarget;
  } else {
    scaledTail = scaleToTarget(tail, tailTarget);
  }
  for (let i = 0; i < scaledTail.length; i += 1) {
    result[idx + 1 + i] = scaledTail[i];
  }
  return result;
}

// Set the uncategorized share to `newValue` (clamped to [0, total]). The
// categories scale proportionally to fit `total - newValue`.
export function setUncategorized(
  shares: number[],
  newValue: number,
  total: number,
): number[] {
  const result = [...shares];
  const clamped = clamp(newValue, 0, total);
  const target = total - clamped;
  const cats = result.slice(0, -1);
  const scaled = scaleToTarget(cats, target);
  for (let i = 0; i < scaled.length; i += 1) {
    result[i] = scaled[i];
  }
  result[result.length - 1] = clamped;
  return result;
}

// Percentage of `share` relative to `total`, rounded to 1 decimal place.
export function percentOf(share: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((share / total) * 1000) / 10;
}

// Re-sort category shares by descending value, applying a stable matching
// permutation. Returns both the new shares array and the index permutation
// used (so callers can reorder parallel meta arrays).
export function sortByShareDesc<T>(
  shares: number[],
  meta: T[],
): { shares: number[]; meta: T[] } {
  const cats = shares.slice(0, -1);
  const uncat = shares[shares.length - 1];
  const order = cats
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  return {
    shares: [...order.map((o) => cats[o.i]), uncat],
    meta: order.map((o) => meta[o.i]),
  };
}
