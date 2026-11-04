import type { StaticTab } from "../components/Tabs";

/** Where a step's button leads: a screen, or the first report. */
export type GuideTarget = StaticTab | "report";

export interface GuideStep {
  /** Texts are `guide.steps.<id>.{title,body,done}`, plus `warning` if marked. */
  id: string;
  open: GuideTarget;
  warning?: boolean;
}

/** The monthly routine, in the order that makes each step's result count: the
 *  data first, then what the agent reads, then categories, then the report. */
export const GUIDE_STEPS: GuideStep[] = [
  { id: "statements", open: "accounts" },
  { id: "telegram", open: "accounts" },
  { id: "regular", open: "accounts" },
  { id: "documents", open: "documents" },
  { id: "context", open: "context" },
  { id: "links", open: "transactions", warning: true },
  { id: "categories", open: "transactions" },
  { id: "report", open: "report" },
];
