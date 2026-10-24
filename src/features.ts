// Switches for ablation runs: each context-engineering feature can be turned off and compared.
export interface AgentFeatures {
  /** "window" trims old turns to the token budget; "none" sends the full history. */
  context: "window" | "none";
  /** Shorten long tool results before they enter the context; full output stays in the logs. */
  truncate: boolean;
  /** What replaces dropped turns: nothing, a summary built from run records, or a model-written one. */
  summary: "none" | "rule" | "llm";
  /** Add a generated overview of files and top-level symbols to the fixed context. */
  repoMap: boolean;
  /** Add AGENTS.md / CLAUDE.md from the project root to the fixed context, as data. */
  projectNotes: boolean;
}

export const defaultFeatures: AgentFeatures = {
  context: "window",
  truncate: true,
  summary: "rule",
  repoMap: true,
  projectNotes: true,
};

const onOff = (name: string, value: string) => {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`--${name} 只能是 on 或 off`);
};

const oneOf = <T extends string>(name: string, value: string, allowed: readonly T[]) => {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`--${name} 只能是 ${allowed.join("、")}`);
  return value as T;
};

/** Parse CLI strings; options left undefined keep their defaults. */
export function parseFeatures(values: {
  context?: string; truncate?: string; summary?: string; "repo-map"?: string; "project-notes"?: string;
}): Partial<AgentFeatures> {
  const features: Partial<AgentFeatures> = {};
  if (values.context !== undefined) features.context = oneOf("context", values.context, ["window", "none"] as const);
  if (values.truncate !== undefined) features.truncate = onOff("truncate", values.truncate);
  if (values.summary !== undefined) features.summary = oneOf("summary", values.summary, ["none", "rule", "llm"] as const);
  if (values["repo-map"] !== undefined) features.repoMap = onOff("repo-map", values["repo-map"]);
  if (values["project-notes"] !== undefined) features.projectNotes = onOff("project-notes", values["project-notes"]);
  return features;
}
