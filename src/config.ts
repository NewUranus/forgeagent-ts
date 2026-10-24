import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "dotenv";
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
config({ path: path.join(ROOT, ".env"), quiet: true });
export function modelConfig() {
  const prefix = (process.env.MODEL_PROVIDER ?? "QWEN").toUpperCase();
  const key = process.env[`${prefix}_API_KEY`];
  const base = process.env[`${prefix}_BASE_URL`];
  const model = process.env[`${prefix}_MODEL`];
  if (!key || !base || !model)
    throw new Error(
      `请在 .env 设置 ${prefix}_API_KEY、${prefix}_BASE_URL、${prefix}_MODEL`,
    );
  return { key, base, model };
}

export function contextConfig() {
  const windowTokens = Number(
    process.env.CONTEXT_WINDOW_TOKENS ?? "32768",
  );
  const outputReserveTokens = Number(
    process.env.CONTEXT_OUTPUT_RESERVE_TOKENS ?? "4096",
  );
  if (!Number.isSafeInteger(windowTokens) || windowTokens <= 0) {
    throw new Error("CONTEXT_WINDOW_TOKENS 必须是正安全整数");
  }
  if (!Number.isSafeInteger(outputReserveTokens) || outputReserveTokens < 0 || outputReserveTokens >= windowTokens) {
    throw new Error("CONTEXT_OUTPUT_RESERVE_TOKENS 必须是非负安全整数，且小于上下文总预算");
  }

  return{
    windowTokens,
    outputReserveTokens,
    inputBudget: windowTokens - outputReserveTokens,
  }
}

export async function postJson(
  base: string,
  endpoint: string,
  body: unknown,
  key = "",
) {
  const response = await fetch(`${base.replace(/\/$/, "")}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw await ApiError.from(response);
  return response.json();
}

/** A non-2xx API response: keeps what retry and overflow handling need to decide. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs: number | null,
  ) {
    super(`API 请求失败：HTTP ${status}${body ? `：${body.slice(0, 500)}` : ""}`);
    this.name = "ApiError";
  }

  static async from(response: Response) {
    const body = await response.text().catch(() => "");
    return new ApiError(response.status, body, parseRetryAfter(response.headers.get("retry-after")));
  }
}

/** Retry-After is either delay seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
