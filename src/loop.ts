// Detect an agent that repeats itself without progress. Three signals, each counted as a streak:
// the same tool call with the same arguments, the same full-test result with no write in between,
// and the same failed completion check. A detection resets its streak, so a second detection needs
// another full streak; the agent warns once and stops on the second detection.

/** JSON with object keys sorted at every level, so {"a":1,"b":2} and {"b":2,"a":1} compare equal. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

class Streak {
  private last: string | null = null;
  private count = 0;
  constructor(private readonly limit: number) {}
  /** Returns true when the same key has now been seen `limit` times in a row. */
  push(key: string) {
    this.count = key === this.last ? this.count + 1 : 1;
    this.last = key;
    if (this.count < this.limit) return false;
    this.count = 0;
    return true;
  }
  reset() {
    this.last = null;
    this.count = 0;
  }
}

export class LoopDetector {
  private calls: Streak;
  private tests: Streak;
  private checks: Streak;
  constructor(readonly limit = 3) {
    this.calls = new Streak(limit);
    this.tests = new Streak(limit);
    this.checks = new Streak(limit);
  }

  recordCall(name: string, argumentsJson: string): string | null {
    let args: string;
    try { args = stableStringify(JSON.parse(argumentsJson)); }
    catch { args = argumentsJson; }
    return this.calls.push(`${name}:${args}`) ? `连续 ${this.limit} 次以相同参数调用 ${name}` : null;
  }

  /** Any write is progress: identical test results before and after it are not a loop. */
  recordWrite() {
    this.tests.reset();
  }

  recordTest(resultKey: string): string | null {
    return this.tests.push(resultKey) ? `连续 ${this.limit} 次全量测试结果完全相同，期间没有修改代码` : null;
  }

  recordFailedCheck(issuesKey: string): string | null {
    return this.checks.push(issuesKey) ? `连续 ${this.limit} 次因相同原因未通过结束检查` : null;
  }
}
