/// Backend→frontend event bus over Server-Sent Events (`GET /api/events`).
/// Drop-in replacement for `listen` from `@tauri-apps/api/event`: the
/// callback receives `{ event, payload }` and the returned promise resolves
/// with an unlisten function. A single shared EventSource serves every
/// subscriber; the browser reconnects it automatically after network blips
/// (missed events are not replayed — same fire-and-forget semantics as the
/// desktop build).

export type UnlistenFn = () => void;

export interface AppEvent<T> {
  event: string;
  payload: T;
}

type Handler = (e: AppEvent<never>) => void;

let source: EventSource | null = null;
const handlers = new Map<string, Set<Handler>>();

function ensureSource(): void {
  if (source) return;
  source = new EventSource("/api/events");
  source.onmessage = (message) => {
    let parsed: AppEvent<never>;
    try {
      parsed = JSON.parse(message.data) as AppEvent<never>;
    } catch {
      return;
    }
    handlers.get(parsed.event)?.forEach((handler) => handler(parsed));
  };
}

export async function listen<T>(
  event: string,
  callback: (e: AppEvent<T>) => void,
): Promise<UnlistenFn> {
  ensureSource();
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  const handler = callback as Handler;
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}
