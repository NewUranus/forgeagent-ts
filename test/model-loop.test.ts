import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ApiError, parseRetryAfter } from "../src/config.ts";
import { backoffDelay, isAccountError, isContextOverflow, isQuotaExhausted, isRetryable, withRetry } from "../src/model/retry.ts";
import { assembleChunks, parseSSE } from "../src/model/stream.ts";
import { LoopDetector, stableStringify } from "../src/loop.ts";
import { estimateRequestToken } from "../src/context/context.ts";
import { runAgent } from "../src/agent.ts";
import type { Message } from "../src/types.ts";

const call = (id: string, name: string, args = {}): Message => ({ role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const done: Message = { role: "assistant", content: "完成" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const reply = (message: Message) => json({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
const overflow = () => json({ error: { message: "This model's maximum context length is 8192 tokens" } }, 400);

async function temp(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-model-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function env(t: any, values: Record<string, string>) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}
const apiEnv = (t: any) => env(t, {
  MODEL_PROVIDER: "LOOP_TEST", LOOP_TEST_API_KEY: "test-only", LOOP_TEST_BASE_URL: "https://example.invalid/v1",
  LOOP_TEST_MODEL: "loop-test", CONTEXT_WINDOW_TOKENS: "32768", CONTEXT_OUTPUT_RESERVE_TOKENS: "256",
  MODEL_MAX_RETRIES: "3", MODEL_RETRY_BASE_MS: "1", MODEL_RETRY_MAX_MS: "5",
});
async function source(t: any, files: Record<string, string> = {}) {
  const base = await temp(t);
  const dir = path.join(base, "source");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "ok.test.js"), 'require("node:test")("ok", () => {});');
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  return { base, source: dir };
}
const plain = { repoMap: false, projectNotes: false, summary: "none" as const };

test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0.5"), 500);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(parseRetryAfter("soon"), null);
  assert.equal(parseRetryAfter(null), null);
});

test("only transient failures are retried; overflow is recognised from the error body", () => {
  for (const status of [408, 429, 500, 503]) assert.ok(isRetryable(new ApiError(status, "", null)), String(status));
  for (const status of [400, 401, 403, 404]) assert.ok(!isRetryable(new ApiError(status, "", null)), String(status));
  assert.ok(isRetryable(new TypeError("fetch failed")));
  assert.ok(!isRetryable(new Error("bug")));
  assert.ok(isContextOverflow(new ApiError(400, '{"error":{"code":"context_length_exceeded"}}', null)));
  assert.ok(isContextOverflow(new ApiError(400, "Range of input length should be [1, 30720]", null)));
  assert.ok(!isContextOverflow(new ApiError(400, "invalid tool schema", null)));
  assert.ok(!isContextOverflow(new ApiError(500, "context length", null)));
});

test("an exhausted quota is never retried, whatever the status; a plain rate limit still is", () => {
  const openai = new ApiError(429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}', null);
  // DashScope's reply when the free tier ran out (recorded 2026-10-25).
  const dashscope = new ApiError(403, '{"error":{"message":"Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the \\"use free tier only\\" mode in the management console.","type":"insufficient_quota","code":"insufficient_quota"}}', null);
  const rateLimit = new ApiError(429, '{"error":{"message":"Rate limit reached for requests per min (RPM): Limit 60, Used 60, Requested 1.","type":"requests","code":"rate_limit_exceeded"}}', 2000);
  for (const quota of [openai, dashscope, new ApiError(429, "账户余额不足", null)]) {
    assert.ok(isQuotaExhausted(quota) && !isRetryable(quota) && isAccountError(quota), quota.body.slice(0, 40));
  }
  assert.ok(!isQuotaExhausted(rateLimit) && isRetryable(rateLimit) && !isAccountError(rateLimit));
  assert.ok(!isQuotaExhausted(new ApiError(500, "insufficient_quota", null)), "5xx 不按额度耗尽处理");
  for (const status of [401, 403, 404]) assert.ok(isAccountError(new ApiError(status, "", null)), String(status));
  assert.ok(!isAccountError(new ApiError(400, "bad request", null)));
});

test("backoff uses full jitter under an exponential cap", () => {
  const policy = { retries: 5, baseMs: 100, maxMs: 1000 };
  assert.equal(backoffDelay(0, policy, () => 0), 0);
  assert.equal(backoffDelay(0, policy, () => 0.999), 99);
  assert.equal(backoffDelay(2, policy, () => 0.5), 200);
  assert.equal(backoffDelay(10, policy, () => 0.999), 999, "不超过上限");
});

test("withRetry retries transient errors, honours Retry-After and gives up on the rest", async () => {
  const policy = { retries: 2, baseMs: 100, maxMs: 1000 };
  const delays: number[] = [];
  const hooks = { sleep: async (ms: number) => { delays.push(ms); }, random: () => 0 };
  const failing = (errors: unknown[], value = "ok") => { let calls = 0; const fn = async () => { calls++; if (errors.length) throw errors.shift(); return value; }; return { fn, calls: () => calls }; };

  const rateLimited = failing([new ApiError(429, "", 2000)]);
  assert.equal(await withRetry(rateLimited.fn, policy, hooks), "ok");
  assert.deepEqual(delays, [2000], "不早于服务端要求的时间");

  const auth = failing([new ApiError(401, "bad key", null)]);
  await assert.rejects(withRetry(auth.fn, policy, hooks), /401/);
  assert.equal(auth.calls(), 1);

  const down = failing([new ApiError(503, "", null), new ApiError(503, "", null), new ApiError(503, "", null)]);
  await assert.rejects(withRetry(down.fn, policy, hooks), /503/);
  assert.equal(down.calls(), 3, "首次 + 2 次重试");

  const longWait = failing([new ApiError(429, "", 600_000)]);
  await assert.rejects(withRetry(longWait.fn, policy, hooks), /429/);
  assert.equal(longWait.calls(), 1, "服务端要求等太久就不等");
});

test("stableStringify ignores key order at every level", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("loop detector: streaks of identical calls, unchanged test results and failed checks", () => {
  const loop = new LoopDetector(3);
  assert.equal(loop.recordCall("read_file", '{"relative_path":"a","start_line":1}'), null);
  assert.equal(loop.recordCall("read_file", '{"start_line":1,"relative_path":"a"}'), null, "参数顺序不同也算相同");
  assert.match(loop.recordCall("read_file", '{"relative_path":"a","start_line":1}')!, /连续 3 次以相同参数调用 read_file/);
  assert.equal(loop.recordCall("read_file", '{"relative_path":"a","start_line":1}'), null, "检测后重新计数");
  assert.equal(loop.recordCall("list_files", "{}"), null);

  assert.equal(loop.recordTest("fail:a"), null);
  assert.equal(loop.recordTest("fail:a"), null);
  loop.recordWrite();
  assert.equal(loop.recordTest("fail:a"), null, "期间有写入就不算重复");
  assert.equal(loop.recordTest("fail:a"), null);
  assert.match(loop.recordTest("fail:a")!, /测试结果完全相同/);

  assert.equal(loop.recordFailedCheck("x"), null);
  assert.equal(loop.recordFailedCheck("x"), null);
  assert.match(loop.recordFailedCheck("x")!, /结束检查/);
});

const bytes = (...parts: (string | Uint8Array)[]) => (async function* () {
  for (const part of parts) yield typeof part === "string" ? new TextEncoder().encode(part) : part;
})();

test("parseSSE handles events split across chunks, CRLF, comments, multi-line data and a split character", async () => {
  const ni = new TextEncoder().encode("你");
  const events: string[] = [];
  for await (const data of parseSSE(bytes(": keep-alive\n\nda", "ta: {\"a\":1}\r\n\r\ndata: line1\ndata: line2\n\ndata: ", ni.slice(0, 2), ni.slice(2), "\n\nevent: x\ndata: last")))
    events.push(data);
  assert.deepEqual(events, ['{"a":1}', "line1\nline2", "你", "last"]);
});

test("assembleChunks joins content and tool-call fragments by index", () => {
  const response = assembleChunks([
    { id: "c1", model: "m", choices: [{ delta: { role: "assistant", content: "先" } }] },
    { choices: [{ delta: { content: "检查", tool_calls: [{ index: 0, id: "t0", type: "function", function: { name: "read_", arguments: '{"rel' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'ative_path":"a"}' } }, { index: 1, id: "t1", function: { name: "run_tests", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
  ]);
  assert.deepEqual(response.choices[0].message, { role: "assistant", content: "先检查", tool_calls: [
    { id: "t0", type: "function", function: { name: "read_file", arguments: '{"relative_path":"a"}' } },
    { id: "t1", type: "function", function: { name: "run_tests", arguments: "{}" } },
  ] });
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(response.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  assert.throws(() => assembleChunks([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] }]), /缺少 id 或名称/);
});

test("API run retries transient failures and records them per round", async t => {
  apiEnv(t);
  const { base, source: dir } = await source(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls <= 2) return json({ error: "busy" }, 503);
    return reply(done);
  });
  const report = await runAgent({ base, source: dir, mock: false, maxRounds: 1, features: plain });
  assert.equal(calls, 3);
  assert.equal(report.statistics.model_requests.retries, 2);
  assert.equal(report.termination.reason, "round_limit", "重试成功后正常继续，没有因模型错误结束");
  const meta = JSON.parse(await fs.readFile(path.join(report.task_dir, "model/round-001/meta.json"), "utf8"));
  assert.equal(meta.retries, 2);
});

test("streaming assembles tool calls from SSE chunks and logs the assembled response", async t => {
  apiEnv(t);
  const { base, source: dir } = await source(t);
  const sse = (chunks: object[]) => {
    const text = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    // Deliver in odd-sized pieces so events cross chunk boundaries.
    const encoded = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    bodies.push(JSON.parse(options.body as string));
    return bodies.length === 1
      ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "t", type: "function", function: { name: "run_", arguments: "{" } }] } }] },
             { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "tests", arguments: "}" } }] }, finish_reason: "tool_calls" }] },
             { choices: [], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } }])
      : sse([{ choices: [{ delta: { content: "完" } }] }, { choices: [{ delta: { content: "成" }, finish_reason: "stop" }] }]);
  });
  const report = await runAgent({ base, source: dir, mock: false, maxRounds: 2, stream: true, features: plain });
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.ok(report.tests.runs.some((run: any) => run.phase === "agent"), "拼出的 run_tests 被执行");
  const second = JSON.parse(await fs.readFile(path.join(report.task_dir, "model/round-002/response.json"), "utf8"));
  assert.equal(second.choices[0].message.content, "完成");
  assert.equal(report.statistics.model.usage.prompt_tokens, 7);
});

test("a server-side context overflow shrinks the window and resends the same round", async t => {
  apiEnv(t);
  // Many short lines: read_file caps single long lines itself, so the old turn must be large by line count.
  const large = Array.from({ length: 300 }, (_, i) => `old-output line ${i} ${"x".repeat(40)}`).join("\n");
  const { base, source: dir } = await source(t, { "large.txt": large });
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    requests.push(request);
    if (requests.length === 1) return reply(call("read", "read_file", { relative_path: "large.txt" }));
    if (requests.length === 2) return reply(call("list", "list_files"));
    if (requests.length === 3) {
      // Client budget exactly fits this request, but the server still says it is too long.
      process.env.CONTEXT_WINDOW_TOKENS = String(estimateRequestToken(request.messages, request.tools) + 256);
      return overflow();
    }
    return reply(done);
  });
  const report = await runAgent({ base, source: dir, mock: false, maxRounds: 3, features: plain });
  assert.equal(requests.length, 4);
  assert.ok(JSON.stringify(requests[2]).includes("old-output"));
  assert.ok(!JSON.stringify(requests[3]).includes("old-output"), "重发时去掉了最旧的一组");
  assert.equal(report.statistics.model_requests.context_overflow_retries, 1);
  const meta = JSON.parse(await fs.readFile(path.join(report.task_dir, "model/round-003/meta.json"), "utf8"));
  assert.equal(meta.context_overflow_retries, 1);
  await assert.rejects(fs.access(path.join(report.task_dir, "model/round-003/error.json")), "成功后不留旧的 error.json");
});

test("with context management off, a server overflow ends as server_context_limit", async t => {
  apiEnv(t);
  const { base, source: dir } = await source(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return overflow(); });
  const report = await runAgent({ base, source: dir, mock: false, features: { ...plain, context: "none" } });
  assert.equal(calls, 1, "上下文超限不按普通错误重试");
  assert.equal(report.status, "error");
  assert.equal(report.termination.reason, "server_context_limit");
});

test("repeating the same call gets one warning, then the run stops as loop_detected", async t => {
  const { base, source: dir } = await source(t);
  const seen: Message[][] = [];
  const report = await runAgent({ base, source: dir, maxRounds: 10, features: plain,
    reply: async (messages) => { seen.push(structuredClone(messages)); return call(`l${seen.length}`, "list_files"); } });
  assert.equal(report.status, "failed");
  assert.equal(report.termination.reason, "loop_detected");
  assert.equal(seen.length, 6, "第 3 次警告，第 6 次终止");
  assert.match(seen[3].at(-1)!.content!, /检测到重复且没有进展的操作：\n- 连续 3 次以相同参数调用 list_files/);
  assert.equal(report.statistics.loop.warnings, 1);
  assert.equal(report.statistics.loop.detections.length, 2);

  const off = await runAgent({ base, source: dir, maxRounds: 7, features: { ...plain, loopGuard: false },
    reply: async () => call("l", "list_files") });
  assert.equal(off.termination.reason, "round_limit");
  assert.deepEqual(off.statistics.loop.detections, []);
});
