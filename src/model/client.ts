import { postJson } from "../config.js";
import { withRetry, type RetryPolicy } from "./retry.js";
import { postStream } from "./stream.js";

export interface CallRecord {
  retries: number;
  errors: string[];
}

/**
 * One chat completion with retries. Streaming and non-streaming return the same response shape.
 * A streamed attempt that fails midway is retried from scratch: partial output is discarded.
 */
export async function chatCompletion(
  base: string, key: string, request: Record<string, unknown>,
  options: { stream?: boolean; policy: RetryPolicy; record: CallRecord; onText?: (text: string) => void },
) {
  return withRetry(
    () => options.stream
      ? postStream(base, "chat/completions", request, key, { onText: options.onText })
      : postJson(base, "chat/completions", request, key),
    options.policy,
    {
      onRetry: (attempt, delay, error) => {
        options.record.retries++;
        options.record.errors.push(String(error).slice(0, 300));
        console.error(`模型请求失败，${delay} 毫秒后第 ${attempt} 次重试：${String(error).slice(0, 200)}`);
      },
    },
  );
}
