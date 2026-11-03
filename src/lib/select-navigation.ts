/** Keyboard logic of `SelectDropdown`, apart from the DOM. */

/** The option a key moves to, or null when the key does not navigate. */
export function indexAfterKey(key: string, active: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(active + 1, count - 1);
    case "ArrowUp":
      return Math.max(active - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The first option starting with the typed text, looking on from `active`
 *  when one letter is repeated, so that it walks through the matching options. */
export function indexByTyping(labels: string[], typed: string, active: number): number | null {
  const query = typed.toLocaleLowerCase();
  if (!query) return null;
  const repeated = [...query].every((c) => c === query[0]);
  const start = repeated ? active + 1 : 0;
  const needle = repeated ? query[0] : query;
  for (let i = 0; i < labels.length; i += 1) {
    const at = (start + i) % labels.length;
    if (labels[at].toLocaleLowerCase().startsWith(needle)) return at;
  }
  return null;
}
