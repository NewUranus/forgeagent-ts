import { ApiError } from "../config.js";

export interface RetryPolicy {
  /** Retries after the first attempt. */
  retries: number;
  baseMs: number;
  maxMs: number;
}

export function retryPolicy(): RetryPolicy {
  const read = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
    return value;
  };
  return { retries: read("MODEL_MAX_RETRIES", 3), baseMs: read("MODEL_RETRY_BASE_MS", 1000), maxMs: read("MODEL_RETRY_MAX_MS", 30000) };
}

// Longer server-requested waits are not worth blocking the run for.
const MAX_SERVER_WAIT_MS = 120000;

/**
 * Transient failures only: rate limits, timeouts, server errors and network errors.
 * 400/401/403/404 and context overflow would fail again with the same request.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return !isQuotaExhausted(error) && ([408, 409, 425, 429].includes(error.status) || error.status >= 500);
  if (error instanceof Error) return error.name === "TypeError" || error.name === "TimeoutError" || error.name === "AbortError" || error.name === "StreamIdleError";
  return false;
}

/**
 * Out of quota or balance: nothing works until a person adds funds. Some providers send this as 429,
 * the same status as a short rate limit, so only the body tells them apart.
 */
export function isQuotaExhausted(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 &&
    /insufficient_quota|billing_hard_limit|exceeded your current quota|quota (?:is |has been )?exhausted|arrearage|余额不足|欠费|额度(?:已)?(?:用尽|耗尽|不足)/i.test(error.body);
}

/** Every later call fails the same way until a person fixes the account or settings: key, access, model name, quota. */
export function isAccountError(error: unknown): boolean {
  return isQuotaExhausted(error) || (error instanceof ApiError && [401, 403, 404].includes(error.status));
}

/** The request asked for more tokens than the model accepts; only a smaller request can succeed. */
export function isContextOverflow(error: unknown): boolean {
  return error instanceof ApiError && [400, 413].includes(error.status) &&
    /context.length|context_length_exceeded|maximum context|too many tokens|token limit|input is too long|range of input length|prompt is too long|超出.{0,6}(上下文|长度)/i.test(error.body);
}

/** "Full jitter": a random delay up to the exponential cap, so many clients do not retry in lockstep. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random = Math.random) {
  return Math.floor(random() * Math.min(policy.maxMs, policy.baseMs * 2 ** attempt));
}

export interface RetryHooks {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy, hooks: RetryHooks = {}): Promise<T> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= policy.retries || !isRetryable(error)) throw error;
      const serverWait = error instanceof ApiError ? error.retryAfterMs : null;
      if (serverWait !== null && serverWait > MAX_SERVER_WAIT_MS) throw error;
      // Never retry earlier than the server asked to.
      const delay = Math.max(serverWait ?? 0, backoffDelay(attempt, policy, hooks.random));
      hooks.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }
}
