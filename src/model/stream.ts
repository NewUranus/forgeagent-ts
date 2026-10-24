import { ApiError } from "../config.js";

/**
 * Yield the `data` payload of each server-sent event. Events end with a blank line; network chunks
 * can split anywhere (even inside a multi-byte character), so text is decoded in streaming mode
 * and only complete events are emitted. Comment lines (":") and other fields are ignored.
 */
export async function* parseSSE(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const take = function* (final: boolean) {
    const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = final ? "" : events.pop()!;
    for (const event of events) {
      const data = event
        .split(/\r\n|\n|\r/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length) yield data.join("\n");
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* take(false);
  }
  buffer += decoder.decode();
  yield* take(true);
}

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Fold OpenAI-style chat completion chunks into one non-streaming response, so logging, replay
 * and the agent loop see the same shape either way. Tool call fields arrive in pieces keyed by
 * `index`: the id and name usually come first, the JSON arguments in many fragments.
 */
export function assembleChunks(chunks: any[]) {
  let content: string | null = null;
  let finishReason: string | null = null;
  let usage: unknown = undefined;
  let id: string | undefined, model: string | undefined;
  const calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  for (const chunk of chunks) {
    id ??= chunk.id;
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue; // e.g. the final usage-only chunk
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content = (content ?? "") + delta.content;
    for (const part of (delta.tool_calls ?? []) as ToolCallDelta[]) {
      const call = (calls[part.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  }
  const toolCalls = calls.filter(Boolean);
  if (toolCalls.some((call) => !call.id || !call.function.name)) throw new Error("流式响应中的工具调用缺少 id 或名称");
  return {
    id, model, object: "chat.completion", streamed_chunks: chunks.length,
    choices: [{ index: 0, finish_reason: finishReason,
      message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
    ...(usage ? { usage } : {}),
  };
}

export class StreamIdleError extends Error {
  constructor(ms: number) {
    super(`流式响应超过 ${ms} 毫秒没有新数据`);
    this.name = "StreamIdleError";
  }
}

/**
 * POST with stream: true and assemble the result. The timeout is an idle timeout, reset on every
 * chunk: a long answer that keeps streaming is fine, a stalled connection is not.
 */
export async function postStream(
  base: string, endpoint: string, body: unknown, key: string,
  options: { onText?: (text: string) => void; idleMs?: number } = {},
) {
  const idleMs = options.idleMs ?? 60000;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new StreamIdleError(idleMs)), idleMs);
  };
  arm();
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw await ApiError.from(response);
    if (!response.body) throw new Error("流式响应没有内容");
    const chunks: any[] = [];
    const bytes = (async function* () {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        arm();
        yield chunk;
      }
    })();
    for await (const data of parseSSE(bytes)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(`流式响应返回错误：${JSON.stringify(chunk.error).slice(0, 500)}`);
      chunks.push(chunk);
      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text === "string" && text) options.onText?.(text);
    }
    return assembleChunks(chunks);
  } catch (error) {
    // An abort carries the idle error as its reason; surface that instead of a generic AbortError.
    throw controller.signal.aborted && controller.signal.reason instanceof StreamIdleError ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}
