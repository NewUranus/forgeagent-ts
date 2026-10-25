export interface RetryOptions {
  /** Total number of calls, including the first one. */
  attempts: number;
  delayMs?: number;
}

/** Call fn until it succeeds, at most `attempts` times; rethrow the last error when every call fails. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, { attempts, delayMs = 0 }: RetryOptions): Promise<T | undefined> {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be a positive integer");
  for (let attempt = 1; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return undefined;
}
