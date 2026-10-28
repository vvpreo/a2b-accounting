import { Dispatch, SetStateAction, useCallback, useState } from "react";

/** Screen state that must survive switching tabs: a screen is unmounted when
 *  the user leaves it, so plain `useState` would come back with defaults.
 *  Values live in a module-level cache (switching tabs) mirrored to
 *  `sessionStorage` (a reload of the same browser tab). Per viewer only —
 *  nothing reaches the database. Values must be JSON-serialisable. */
const cache = new Map<string, unknown>();
const PREFIX = "a2b.view.";

function read<T>(key: string): { found: true; value: T } | { found: false } {
  if (cache.has(key)) return { found: true, value: cache.get(key) as T };
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw !== null) {
      const value = JSON.parse(raw) as T;
      cache.set(key, value);
      return { found: true, value };
    }
  } catch {
    // Storage blocked or a corrupt entry — fall back to the default.
  }
  return { found: false };
}

function write(key: string, value: unknown) {
  cache.set(key, value);
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the in-memory cache still covers tab switches.
  }
}

export function useViewState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const stored = read<T>(key);
    if (stored.found) return stored.value;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        write(key, resolved);
        return resolved;
      }),
    [key],
  );
  return [value, set];
}
