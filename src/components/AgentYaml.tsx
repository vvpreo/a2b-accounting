import type { ReactElement } from "react";

import type { ChatMsg } from "../lib/api";

export interface AgentYamlState {
  suggestedCategory: string | null;
  confidence: number | null;
  messages: ChatMsg[];
}

const NBSP = " ";

/** Quote a single-line scalar only when YAML would otherwise misread it. */
function scalarInline(value: string): string {
  if (value === "") return '""';
  if (
    /^[\s#\-?:,\[\]{}&*!|>'"%@`]/.test(value) ||
    value.includes(": ") ||
    value.includes(" #") ||
    value !== value.trim()
  ) {
    return JSON.stringify(value);
  }
  return value;
}

/** Serialize one `key: value` (or `- key: value`) field, using a `|` block
 *  scalar for multi-line strings so long reasoning / raw JSON stays readable.
 *  `keyIndent` is the number of leading spaces before the key. */
function field(
  lines: string[],
  keyIndent: number,
  dash: boolean,
  key: string,
  value: string | number | null,
): void {
  const pad = " ".repeat(keyIndent);
  const head = dash ? `${" ".repeat(keyIndent - 2)}- ` : pad;
  if (value === null) {
    lines.push(`${head}${key}: null`);
    return;
  }
  if (typeof value === "number") {
    lines.push(`${head}${key}: ${value}`);
    return;
  }
  if (value.includes("\n")) {
    lines.push(`${head}${key}: |`);
    const childPad = " ".repeat(keyIndent + 2);
    for (const l of value.split("\n")) lines.push(childPad + l);
    return;
  }
  lines.push(`${head}${key}: ${scalarInline(value)}`);
}

/** Serialize the agent state to a YAML string. */
export function agentStateToYaml(state: AgentYamlState): string {
  const lines: string[] = [];
  field(lines, 0, false, "suggestedCategory", state.suggestedCategory);
  field(lines, 0, false, "confidence", state.confidence);
  if (state.messages.length === 0) {
    lines.push("messages: []");
  } else {
    lines.push("messages:");
    for (const m of state.messages) {
      field(lines, 4, true, "role", m.role);
      field(lines, 4, false, "content", m.content);
    }
  }
  return lines.join("\n");
}

function renderScalar(value: string): ReactElement {
  if (value === "|") return <span className="yml-punct">|</span>;
  if (value === "null") return <span className="yml-null">null</span>;
  if (/^-?\d+(\.\d+)?$/.test(value)) return <span className="yml-num">{value}</span>;
  return <span className="yml-str">{value}</span>;
}

/** Render YAML with lightweight syntax highlighting. Tracks `|` block scalars
 *  by indentation so their multi-line bodies are coloured as strings. */
function highlight(yaml: string): ReactElement[] {
  const out: ReactElement[] = [];
  let blockIndent: number | null = null;

  yaml.split("\n").forEach((line, i) => {
    const indent = line.length - line.replace(/^\s+/, "").length;

    // Inside a block scalar: everything more-indented than the owning key (or
    // a blank line) is literal string content.
    if (blockIndent !== null && (line.trim() === "" || indent > blockIndent)) {
      out.push(
        <div className="yml-line" key={i}>
          <span className="yml-str">{line === "" ? NBSP : line}</span>
        </div>,
      );
      return;
    }
    blockIndent = null;

    const m = line.match(/^(\s*)(-\s+)?([^:]+):(.*)$/);
    if (!m) {
      out.push(
        <div className="yml-line" key={i}>
          {line === "" ? NBSP : line}
        </div>,
      );
      return;
    }

    const [, lead, dashRaw, key, restRaw] = m;
    const rest = restRaw.replace(/^ /, "");
    if (rest === "|") blockIndent = lead.length;

    out.push(
      <div className="yml-line" key={i}>
        {lead}
        {dashRaw && <span className="yml-punct">{dashRaw}</span>}
        <span className="yml-key">{key}</span>
        <span className="yml-punct">:</span>
        {rest !== "" && (
          <>
            {" "}
            {renderScalar(rest)}
          </>
        )}
      </div>,
    );
  });

  return out;
}

/** Syntax-highlighted YAML view of the agent state. */
export function AgentYaml({ state }: { state: AgentYamlState }) {
  return <div className="txn-agent-yaml">{highlight(agentStateToYaml(state))}</div>;
}
