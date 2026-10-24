import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runAgent } from "../src/agent.ts";
import { summarizeTest, fingerprint } from "../src/report.ts";
import type { Message } from "../src/types.ts";

const call = (name: string, args = {}): Message => ({ role: "assistant", content: null,
  tool_calls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const done: Message = { role: "assistant", content: "完成" };
const plan = call("update_plan", { steps: [{ id: "fix", description: "修复并验证", status: "completed" }] });
const good = "export const answer = 42;\n";
const bad = "export const answer = 0;\n";
async function fixture(t: any, code = bad) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-report-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "answer.js"), code);
  await fs.writeFile(path.join(source, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(source, "answer.test.js"),
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { answer } from "./answer.js"; test("answer is 42", () => assert.equal(answer, 42));');
  return { base, source };
}

test("report captures real baseline failure, verified repair, fingerprint and unchanged source", async t => {
  const { base, source } = await fixture(t);
  const initial = await fingerprint(source);
  const replies = [call("write_file", { relative_path: "answer.js", content: good }), call("run_tests"), plan, done];
  const report = await runAgent({ base, source, task: "repair answer", reply: async () => replies.shift()!, maxRounds: 4 });
  assert.equal(report.status, "passed");
  assert.equal(report.termination.reason, "completed");
  assert.equal(report.termination.verified, true);
  assert.equal(report.termination.plan.all_completed, true);
  assert.deepEqual(report.task.initial_fingerprint, initial);
  assert.equal(report.tests.comparison, "failed_to_passed");
  assert.equal(report.tests.baseline?.counts.failed, 1);
  assert.equal(report.tests.latest?.counts.passed, 1);
  assert.deepEqual(report.tests.fixed_test_names, ["answer is 42"]);
  assert.equal(report.statistics.model.rounds, 4);
  assert.equal(report.statistics.model.api_calls, 0);
  assert.equal(report.statistics.model.usage.total_tokens, null);
  assert.equal(report.statistics.tool_calls, 3);
  assert.equal(report.statistics.successful_writes, 1);
  assert.equal(report.statistics.test_runs, 2);
  assert.equal(report.changes.added_lines, 1);
  assert.equal(report.changes.deleted_lines, 1);
  assert.equal(report.changes.tests_modified, false);
  assert.equal(await fs.readFile(path.join(source, "answer.js"), "utf8"), bad);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(report.task_dir, "report.json"), "utf8")), report);
  assert.match(await fs.readFile(path.join(report.task_dir, "report.txt"), "utf8"), /failed_to_passed/);
  const runs = (await fs.readFile(path.join(report.task_dir, "tests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(runs.map(run => run.phase), ["baseline", "agent"]);
  assert.match(runs[1].stdout, /answer is 42/);
});

test("passing baseline or earlier tests cannot hide a later write or an unfinished plan", async t => {
  const { base, source } = await fixture(t, good);
  const replies = [call("run_tests"), call("write_file", { relative_path: "answer.js", content: bad }), done];
  const report = await runAgent({ base, source, apply: true, reply: async () => replies.shift()!, maxRounds: 3 });
  assert.equal(report.status, "limit_reached");
  assert.equal(report.termination.reason, "round_limit");
  assert.equal(report.tests.latest?.status, "passed");
  assert.equal(report.tests.latest_is_current, false);
  assert.equal(report.tests.comparison, "unavailable");
  assert.equal(report.termination.verified, false);
  assert.equal(report.applied, false);
  const limit = await runAgent({ base, source, reply: async () => call("run_tests"), maxRounds: 1 });
  assert.equal(limit.termination.verified, true);
  assert.equal(limit.termination.plan.all_completed, false);
  assert.equal(limit.status, "limit_reached");
});

test("apply revalidation is counted and a source conflict still produces a report", async t => {
  const { base, source } = await fixture(t);
  for (const conflict of [true, false]) {
    const replies = [call("write_file", { relative_path: "answer.js", content: good }), call("run_tests"), plan, done];
    const report = await runAgent({ base, source, apply: true, maxRounds: 4, reply: async () => {
      const next = replies.shift()!;
      if (conflict && next === done) await fs.writeFile(path.join(source, "answer.js"), "// external edit\n" + bad);
      return next;
    } });
    assert.equal(report.statistics.test_runs, 3);
    assert.equal(report.tests.latest?.phase, "apply");
    assert.equal(report.termination.reason, conflict ? "source_conflict" : "completed");
    assert.equal(report.applied, !conflict);
    assert.equal(report.status, conflict ? "error" : "passed");
    assert.equal(JSON.parse(await fs.readFile(path.join(report.task_dir, "report.json"), "utf8")).status, report.status);
  }
});

test("baseline alone cannot verify completion, and a newly failing test is reported as a regression", async t => {
  const { base, source } = await fixture(t, good);
  const baselineOnly = [plan, done];
  const first = await runAgent({ base, source, maxRounds: 2, reply: async () => baselineOnly.shift()! });
  assert.equal(first.tests.baseline?.status, "passed");
  assert.equal(first.tests.latest, null);
  assert.equal(first.termination.verified, false);
  assert.equal(first.status, "limit_reached");
  const replies = [call("write_file", { relative_path: "answer.js", content: bad }), call("run_tests"), plan, done];
  const second = await runAgent({ base, source, maxRounds: 4, reply: async () => replies.shift()! });
  assert.equal(second.tests.comparison, "passed_to_failed");
  assert.deepEqual(second.tests.regressed_test_names, ["answer is 42"]);
  assert.equal(second.termination.verified, false);
  assert.equal(second.status, "limit_reached");
});

test("API usage sums only reported numbers and persists failure details", async t => {
  const { base, source } = await fixture(t, good);
  const previous = { MODEL_PROVIDER: process.env.MODEL_PROVIDER, REPORT_API_KEY: process.env.REPORT_API_KEY,
    REPORT_BASE_URL: process.env.REPORT_BASE_URL, REPORT_MODEL: process.env.REPORT_MODEL };
  Object.assign(process.env, { MODEL_PROVIDER: "REPORT", REPORT_API_KEY: "test-only", REPORT_BASE_URL: "http://localhost", REPORT_MODEL: "report-test" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const replies = [call("run_tests"), plan, done];
  t.mock.method(globalThis, "fetch", async () => {
    const message = replies.shift();
    if (!message) throw new Error("simulated model failure");
    return new Response(JSON.stringify({ choices: [{ message }], ...(message === done ? {} : {
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }) }), { headers: { "Content-Type": "application/json" } });
  });
  const report = await runAgent({ base, source, mock: false });
  assert.equal(report.status, "passed");
  assert.equal(report.statistics.model.api_calls, 3);
  assert.deepEqual(report.statistics.model.models, ["report-test"]);
  assert.equal(report.statistics.model.usage.total_tokens, 28);
  assert.equal(report.statistics.model.usage.reported_calls.total_tokens, 2);
  assert.equal(report.statistics.model.usage.complete, false);
  const failed = await runAgent({ base, source, mock: false });
  assert.equal(failed.status, "error");
  assert.equal(failed.termination.reason, "model_error");
  assert.match(failed.termination.error!, /simulated model failure/);
  assert.equal(failed.statistics.model.api_calls, 1);
  assert.equal(failed.statistics.model.usage.total_tokens, null);
  assert.equal(failed.tests.latest, null);
  assert.equal(failed.termination.verified, false);
});

test("pytest subtests, unknown output, and timeouts remain distinguishable", () => {
  const result = { exit_code: 0, time_out: false, stderr: "",
    stdout: "test_names.py::Names::test_valid PASSED [100%]\n==================== 6 passed, 93 subtests passed in 0.03s =====================\n" };
  const py = summarizeTest(result);
  assert.equal(py.counts.passed, 6);
  assert.equal(py.counts.subtests_passed, 93);
  assert.deepEqual(py.passed_test_names, ["test_names.py::Names::test_valid"]);
  const timed = summarizeTest({ ...result, exit_code: null, time_out: true, stdout: "partial output" });
  assert.equal(timed.status, "timeout");
  assert.equal(timed.counts.passed, null);
  assert.equal(summarizeTest({ ...result, exit_code: 2, stdout: "" }).status, "error");
  const subfailed = summarizeTest({ ...result, exit_code: 1, stdout:
    "test_names.py::Names::test_valid PASSED [100%]\nSUBFAILED(word='if') test_names.py::Names::test_valid\n=== 1 failed, 1 passed, 2 subtests passed in 0.03s ===\n" });
  assert.equal(subfailed.counts.failed, 1);
  assert.deepEqual(subfailed.passed_test_names, []);
  assert.deepEqual(subfailed.failed_test_names, ["test_names.py::Names::test_valid"]);
  assert.deepEqual(subfailed.failed_subtest_names, ["test_names.py::Names::test_valid (word='if')"]);
});
