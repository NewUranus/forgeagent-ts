// Shape tool results for the model's context. The full output is still written to trace.jsonl and tests.jsonl.

export const TOOL_STRING_LIMIT = 16000;
// Test failures, stack traces and compiler errors usually sit at the end of command output.
export const OUTPUT_STRING_LIMIT = 6000;
export const TOOL_ARRAY_LIMIT = 300;
const OUTPUT_KEYS = new Set(["stdout", "stderr"]);

const marker = (omitted: number) => `\n……（中间省略 ${omitted} 个字符）……\n`;

/** Keep the head and tail of text within maxChars, marking what was cut from the middle. */
export function truncateMiddle(text: string, maxChars: number, headShare = 0.5): string {
  if (text.length <= maxChars) return text;
  // Reserve room for the longest marker this text could need, so the result never exceeds maxChars.
  const keep = maxChars - marker(text.length).length;
  if (keep <= 0) return text.slice(text.length - maxChars);
  const head = Math.floor(keep * headShare);
  const tail = keep - head;
  return text.slice(0, head) + marker(text.length - head - tail) + text.slice(text.length - tail);
}

/**
 * Truncate inside the value instead of its JSON string, so the result stays valid JSON.
 * stdout/stderr keep more of the tail; long arrays keep their first items plus a count.
 */
export function shrinkForContext(value: unknown, key = ""): unknown {
  if (typeof value === "string")
    return OUTPUT_KEYS.has(key)
      ? truncateMiddle(value, OUTPUT_STRING_LIMIT, 0.25)
      : truncateMiddle(value, TOOL_STRING_LIMIT);
  if (Array.isArray(value)) {
    const items = value.slice(0, TOOL_ARRAY_LIMIT).map((item) => shrinkForContext(item));
    if (value.length > TOOL_ARRAY_LIMIT)
      items.push(`……（共 ${value.length} 项，已省略后 ${value.length - TOOL_ARRAY_LIMIT} 项）`);
    return items;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrinkForContext(v, k)]));
  return value;
}
