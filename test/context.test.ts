import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSlidingWindow, checkContextBudget, estimateRequestToken, ContextBudgetExceededError } from "../src/context/context.ts";
import { contextConfig } from "../src/config.ts";
import { runAgent } from "../src/agent.ts";
import type { Message } from "../src/types.ts";

const fixed: Message[] = [{ role: "system", content: "系统规则" }, { role: "user", content: "原始任务" }];
const call = (id: string, name = "list_files", args = {}): Message => ({
  role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id: string, content = "结果"): Message => ({ role: "tool", tool_call_id: id, content });

test("window preserves history under budget and drops oldest complete groups without mutation", () => {
  const first = [call("old"), result("old", "旧内容".repeat(1000))];
  const second = [call("middle"), result("middle", "中间内容".repeat(500))];
  const latest: Message[] = [{ role: "assistant", content: "完成" }, { role: "user", content: "验证尚未完成，请继续" }];
  const history = [...fixed, ...first, ...second, ...latest];
  const snapshot = structuredClone(history);
  const fullBudget = estimateRequestToken(history, []);
  const full = buildSlidingWindow(history, [], fullBudget);
  assert.equal(full.droppedGroups, 0);
  assert.deepEqual(full.messages, history);
  assert.notEqual(full.messages, history);

  const lastTwo = [...fixed, ...second, ...latest];
  assert.deepEqual(buildSlidingWindow(history, [], estimateRequestToken(lastTwo, [])).messages, lastTwo);
  const minimal = [...fixed, ...latest];
  const clipped = buildSlidingWindow(history, [], estimateRequestToken(minimal, []));
  assert.equal(clipped.droppedGroups, 2);
  assert.deepEqual(clipped.messages, minimal);
  assert.deepEqual(history, snapshot);
});

test("multiple tool calls stay with all results; tools and latest group count toward the budget", () => {
  const parallel = call("a");
  parallel.tool_calls!.push(call("b").tool_calls![0]);
  const group = [parallel, result("b"), result("a")];
  const history = [...fixed, call("old"), result("old", "x".repeat(1000)), ...group];
  const tools = [{ name: "long_tool", description: "工具描述".repeat(100) }];
  const retained = [...fixed, ...group];
  const budget = estimateRequestToken(retained, tools);
  const clipped = buildSlidingWindow(history, tools, budget);
  assert.equal(clipped.droppedGroups, 1);
  assert.deepEqual(clipped.messages, retained);
  assert.throws(() => buildSlidingWindow(history, tools, budget - 1), ContextBudgetExceededError);
  assert.throws(() => buildSlidingWindow(fixed, tools, estimateRequestToken(fixed, [])), ContextBudgetExceededError);
  assert.deepEqual(buildSlidingWindow(fixed, [], 1000).messages, fixed);
});

test("invalid budgets and broken tool relationships are rejected", () => {
  for (const budget of [NaN, Infinity, 0, -1, 1.5]) {
    assert.throws(() => buildSlidingWindow(fixed, [], budget), /inputBudget/);
  }
  assert.throws(() => checkContextBudget(NaN, 100), /estimatedTokens/);
  assert.throws(() => buildSlidingWindow([], [], 1000), /系统规则/);
  assert.throws(() => buildSlidingWindow([...fixed, result("orphan")], [], 1000), /assistant/);
  assert.throws(() => buildSlidingWindow([...fixed, call("a")], [], 1000), /缺少对应结果/);
  assert.throws(() => buildSlidingWindow([...fixed, call("a"), result("b")], [], 1000), /匹配/);
  assert.throws(() => buildSlidingWindow([...fixed, call("a"), result("a"), result("a")], [], 1000), /重复/);
  assert.throws(() => buildSlidingWindow([...fixed, call("a"), call("b")], [], 1000), /缺少对应结果/);
  assert.throws(() => buildSlidingWindow([...fixed, call("a"), { role: "user", content: "反馈" }], [], 1000), /尚未完整/);
  assert.throws(() => buildSlidingWindow([...fixed, { role: "assistant", content: "回答" }, fixed[0]], [], 1000), /中途系统/);
});

function env(t: any, values: Record<string, string>) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

test("configuration rejects values that would bypass or inflate the context budget", t => {
  env(t, { CONTEXT_WINDOW_TOKENS: "1000", CONTEXT_OUTPUT_RESERVE_TOKENS: "100" });
  assert.equal(contextConfig().inputBudget, 900);
  for (const value of ["abc", "Infinity", "", "0", "1.5"]) {
    process.env.CONTEXT_WINDOW_TOKENS = value;
    assert.throws(() => contextConfig(), /CONTEXT_WINDOW_TOKENS/);
  }
  process.env.CONTEXT_WINDOW_TOKENS = "1000";
  for (const value of ["abc", "-1", "1000", "1001"]) {
    process.env.CONTEXT_OUTPUT_RESERVE_TOKENS = value;
    assert.throws(() => contextConfig(), /CONTEXT_OUTPUT_RESERVE_TOKENS/);
  }
});

test("API gets the selected window; irreducible overflow makes no API call and is reported distinctly", async t => {
  env(t, {
    MODEL_PROVIDER: "WINDOW_TEST", WINDOW_TEST_API_KEY: "test-only",
    WINDOW_TEST_BASE_URL: "https://example.invalid/v1", WINDOW_TEST_MODEL: "window-test",
    CONTEXT_WINDOW_TOKENS: "32768", CONTEXT_OUTPUT_RESERVE_TOKENS: "256",
  });
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-window-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "large.txt"), "old-output ".repeat(500));
  await fs.writeFile(path.join(source, "ok.test.js"), 'require("node:test")("ok", () => {});');
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    requests.push(request);
    let message: Message;
    if (requests.length === 1) message = call("read", "read_file", { relative_path: "large.txt" });
    else if (requests.length === 2) {
      // Next turn exceeds this budget unless the old read/result pair is removed.
      process.env.CONTEXT_WINDOW_TOKENS = String(estimateRequestToken(request.messages, request.tools) + 256);
      message = call("list");
    } else message = { role: "assistant", content: "继续检查" };
    return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { "Content-Type": "application/json" } });
  });
  // Plain window behavior: no extra fixed context and no summary message.
  const report = await runAgent({ base, source, mock: false, maxRounds: 3, features: { repoMap: false, projectNotes: false, summary: "none" } });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].messages.slice(0, 2), requests[0].messages);
  assert.equal(requests[2].messages[2].tool_calls[0].id, "list");
  assert.equal(requests[2].messages[3].tool_call_id, "list");
  assert.equal(requests[2].messages.length, 4);
  assert.ok(!JSON.stringify(requests[2]).includes("old-output"));
  const saved = JSON.parse(await fs.readFile(path.join(report.task_dir, "model/round-003/request.json"), "utf8"));
  assert.deepEqual(saved.messages, requests[2].messages);
  assert.match(await fs.readFile(path.join(report.task_dir, "trace.jsonl"), "utf8"), /old-output/);

  process.env.CONTEXT_WINDOW_TOKENS = "257";
  const blocked = await runAgent({ base, source, mock: false, features: { repoMap: false, projectNotes: false, summary: "none" } });
  assert.equal(requests.length, 3);
  assert.equal(blocked.status, "error");
  assert.equal(blocked.termination.reason, "context_limit");
  assert.equal(blocked.statistics.model.api_calls, 0);
});
