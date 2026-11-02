import { Suggestion } from "./api";

/** The category agent looked and was not sure — it named no category, or
 *  its confidence is below the current threshold: a mark with its reason,
 *  nothing to apply, only to dismiss. Lowering the threshold in Settings
 *  turns such guesses into suggestions. */
export function isUnsure(s: Suggestion, minConfidence: number): boolean {
  return (
    s.kind === "category" &&
    (s.categoryId === null || (s.source === "llm" && s.confidence < minConfidence))
  );
}
