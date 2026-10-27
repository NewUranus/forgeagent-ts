import test from "node:test";
import assert from "node:assert/strict";
import { loadRecording, runScenario, SCENARIOS } from "../src/eval/faults.ts";

const RECORDING = new URL("../eval/faults/recordings/pagination-last-page/", import.meta.url).pathname;
const TASKS = new URL("../eval/tasks/", import.meta.url).pathname;

const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!;
const failures = (result: Awaited<ReturnType<typeof runScenario>>) =>
  result.checks.filter((c) => !c.ok).map((c) => `${c.name}：期望 ${c.expected}，实际 ${c.actual}`).join("\n");

// The quick 429 scenarios; the ones that wait on Retry-After run through `npm run faults`.
for (const name of ["429-backoff", "429-exhausted", "429-wait-too-long", "429-stream"]) {
  test(`fault proxy: ${name} behaves as designed`, async () => {
    const result = await runScenario(scenario(name), await loadRecording(RECORDING), TASKS);
    assert.ok(result.passed, failures(result));
  });
}

test("fault proxy: 429 insufficient_quota is not retried", { todo: "isRetryable 只看状态码，额度耗尽也会重试 3 次" }, async () => {
  const result = await runScenario(scenario("429-insufficient-quota"), await loadRecording(RECORDING), TASKS);
  assert.ok(result.passed, failures(result));
});
