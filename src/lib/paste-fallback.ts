/** Safety net for text pastes that Chrome announces but never performs.
 *
 *  Dictation tools (VoiceInk) paste with a synthetic ⌘V. Every now and then
 *  Chrome dispatches the `paste` event to the focused field, with the right
 *  text in `clipboardData`, and then inserts nothing — after that even a manual
 *  ⌘V into the same field may do nothing. So: remember the field's value when
 *  the paste starts and, once the browser has had its turn, insert the text
 *  ourselves if the value is still unchanged and nobody cancelled the paste. */

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password"]);

type TextField = HTMLInputElement | HTMLTextAreaElement;

function isTextField(el: EventTarget | null): el is TextField {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

/** Inserts through the editing pipeline (undo stack, `input` event for React);
 *  if the browser refuses that too, sets the value directly and reports it. */
function insert(el: TextField, text: string, start: number, end: number): void {
  el.setSelectionRange(start, end);
  const before = el.value;
  document.execCommand("insertText", false, text);
  if (el.value !== before) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // The prototype setter bypasses React's value tracker, so React sees the change.
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, before.slice(0, start) + text + before.slice(end));
  el.setSelectionRange(start + text.length, start + text.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function installPasteFallback(): void {
  window.addEventListener(
    "paste",
    (e) => {
      const el = e.target;
      if (!isTextField(el)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      const before = el.value;
      const start = el.selectionStart ?? before.length;
      const end = el.selectionEnd ?? start;
      // Pasting over an identical selection legitimately changes nothing.
      if (before.slice(start, end) === text) return;
      setTimeout(() => {
        if (e.defaultPrevented || !el.isConnected || document.activeElement !== el) return;
        if (el.value !== before) return;
        console.warn("[paste] browser did not insert pasted text, inserting it manually");
        insert(el, text, start, end);
      }, 0);
    },
    true,
  );
}
