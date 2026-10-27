import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runAgent } from "../agent.js";
import { loadTasks, quietly } from "./run.js";

// npm run faults: replay a recorded real run through a local proxy that injects HTTP faults, and check
// that the agent recovers, or stops, the way it is designed to. Every model reply comes from the
// recording, so a scenario costs no tokens and gives the same result every time.

/** An HTTP error returned instead of the recorded reply, on the given attempts of one model round. */
export interface Fault {
  round: number;
  attempts: number[];
  status: number;
  /** Built per request, so an HTTP-date Retry-After can point a few seconds past now. */
  headers?: () => Record<string, string>;
  body?: unknown;
}

export interface ProxyRequest {
  round: number;
  attempt: number;
  at: number;
  status: number;
  body: string;
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** The recorded reply as OpenAI-style SSE: text, each tool call with its arguments in two pieces, then usage. */
function streamReply(res: ServerResponse, response: any) {
  const { id, model, usage } = response;
  const { message, finish_reason } = response.choices[0];
  const chunk = (delta: unknown, finish: string | null = null) =>
    ({ id, model, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
  const chunks: unknown[] = [chunk({ role: "assistant", ...(message.content ? { content: message.content } : {}) })];
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    const args: string = call.function.arguments, half = Math.ceil(args.length / 2);
    chunks.push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: args.slice(0, half) } }] }));
    chunks.push(chunk({ tool_calls: [{ index, function: { arguments: args.slice(half) } }] }));
  }
  chunks.push(chunk({}, finish_reason ?? "stop"));
  if (usage) chunks.push({ id, model, object: "chat.completion.chunk", choices: [], usage });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
}

/** The round advances only on a recorded reply, so a retried request gets the reply the recording had. */
export async function startFaultProxy(responses: unknown[], faults: Fault[]) {
  const requests: ProxyRequest[] = [];
  let served = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const round = served + 1;
    const attempt = requests.filter((r) => r.round === round).length + 1;
    const fault = faults.find((f) => f.round === round && f.attempts.includes(attempt));
    const response = responses[served];
    requests.push({ round, attempt, at: Date.now(), status: fault?.status ?? (response ? 200 : 400), body });
    if (fault) return send(res, fault.status,
      fault.body ?? { error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } }, fault.headers?.());
    // 400 is never retried, so running past the recording fails at once instead of after several retries.
    if (!response) return send(res, 400, { error: { message: "回放录制已用完" } });
    served++;
    if (JSON.parse(body).stream) streamReply(res, response);
    else send(res, 200, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/v1`, requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export interface Recording {
  task: string;
  model: string;
  rounds: number;
  total_tokens: number;
  responses: unknown[];
  patch: string;
}

/** A recording directory: round-NNN.json (raw API responses), changes.patch and recording.json. */
export async function loadRecording(dir: string): Promise<Recording> {
  const meta = JSON.parse(await fs.readFile(path.join(dir, "recording.json"), "utf8"));
  const names = (await fs.readdir(dir)).filter((name) => /^round-\d+\.json$/.test(name)).sort();
  if (names.length !== meta.rounds) throw new Error(`录制 ${dir} 应有 ${meta.rounds} 轮，实际 ${names.length} 轮`);
  const responses = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"))));
  return { ...meta, responses, patch: await fs.readFile(path.join(dir, "changes.patch"), "utf8") };
}

export interface Scenario {
  name: string;
  /** What is injected, and what should happen. */
  description: string;
  faults: Fault[];
  stream?: boolean;
  expect: {
    reason: string;
    retries: number;
    /** Requests the proxy should see for each faulted round. */
    requests: Record<number, number>;
    /** Bounds on the wait before each retry of a faulted round, in ms. */
    minWaitMs?: number;
    maxWaitMs?: number;
    /** The run ends exactly as recorded: passed, same patch, rounds and tokens. */
    matchesRecording?: boolean;
  };
}

const rateLimited = (round: number, attempts: number[], headers?: () => Record<string, string>, body?: unknown): Fault =>
  ({ round, attempts, status: 429, headers, body });

export const SCENARIOS: Scenario[] = [
  { name: "429-retry-after-seconds", description: "第 1 轮前 2 次 429 + Retry-After: 2；应等满 2 秒再重试，最终通过",
    faults: [rateLimited(1, [1, 2], () => ({ "Retry-After": "2" }))],
    expect: { reason: "completed", retries: 2, requests: { 1: 3 }, minWaitMs: 2000, matchesRecording: true } },
  { name: "429-retry-after-date", description: "第 1 轮 1 次 429，Retry-After 是 3 秒后的 HTTP 日期；应等到那时再重试",
    faults: [rateLimited(1, [1], () => ({ "Retry-After": new Date(Date.now() + 3000).toUTCString() }))],
    // HTTP dates have whole seconds, so the wait can be up to one second short of 3.
    expect: { reason: "completed", retries: 1, requests: { 1: 2 }, minWaitMs: 2000, matchesRecording: true } },
  { name: "429-backoff", description: "第 1 轮前 2 次 429，没有 Retry-After；应按指数退避（基数 50ms）重试",
    faults: [rateLimited(1, [1, 2])],
    expect: { reason: "completed", retries: 2, requests: { 1: 3 }, maxWaitMs: 1000, matchesRecording: true } },
  { name: "429-exhausted", description: "第 1 轮连续 4 次 429；重试 3 次后以 model_error 结束",
    faults: [rateLimited(1, [1, 2, 3, 4])],
    expect: { reason: "model_error", retries: 3, requests: { 1: 4 } } },
  { name: "429-wait-too-long", description: "Retry-After: 300，超过 2 分钟上限；不等待，直接失败",
    faults: [rateLimited(1, [1], () => ({ "Retry-After": "300" }))],
    expect: { reason: "model_error", retries: 0, requests: { 1: 1 } } },
  { name: "429-mid-run", description: "第 4 轮（已改代码、准备跑测试）2 次 429 + Retry-After: 1；之前的工具结果不丢不重复",
    faults: [rateLimited(4, [1, 2], () => ({ "Retry-After": "1" }))],
    expect: { reason: "completed", retries: 2, requests: { 4: 3 }, minWaitMs: 1000, matchesRecording: true } },
  { name: "429-stream", description: "--stream，第 1 轮流开始前 2 次 429 + Retry-After: 1；结果与非流式相同",
    stream: true, faults: [rateLimited(1, [1, 2], () => ({ "Retry-After": "1" }))],
    expect: { reason: "completed", retries: 2, requests: { 1: 3 }, minWaitMs: 1000, matchesRecording: true } },
  { name: "429-insufficient-quota", description: "429 + insufficient_quota（额度耗尽，重试无用）；应不重试，立即失败",
    faults: [rateLimited(1, [1, 2, 3, 4], undefined,
      { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } })],
    expect: { reason: "model_error", retries: 0, requests: { 1: 1 } } },
];

export interface Check {
  name: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
}

export interface ScenarioResult {
  scenario: string;
  description: string;
  passed: boolean;
  checks: Check[];
  reason: string;
  retries: number;
  /** Waits before each retry of the faulted rounds, in ms. */
  waits_ms: number[];
  duration_ms: number;
  task_dir: string;
}

// Settings for one scenario: a provider prefix of its own, so the real key in .env is never read or sent.
function scenarioEnv(base: string, model: string) {
  return { MODEL_PROVIDER: "FAULTPROXY", FAULTPROXY_API_KEY: "fault-proxy", FAULTPROXY_BASE_URL: base, FAULTPROXY_MODEL: model,
    MODEL_MAX_RETRIES: "3", MODEL_RETRY_BASE_MS: "50", MODEL_RETRY_MAX_MS: "200" };
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runScenario(scenario: Scenario, recording: Recording, taskDir: string, quiet = true): Promise<ScenarioResult> {
  const [task] = await loadTasks(taskDir, [recording.task]);
  const proxy = await startFaultProxy(recording.responses, scenario.faults);
  const start = performance.now();
  let report: Awaited<ReturnType<typeof runAgent>>;
  try {
    const run = () => runAgent({ source: task.project, task: task.instruction, mock: false, stream: scenario.stream,
      testConfig: task.testCommand ? { command: task.testCommand } : {} });
    report = await withEnv(scenarioEnv(proxy.base, recording.model), () => quiet ? quietly(run) : run());
  } finally {
    await proxy.close();
  }
  const { expect } = scenario;
  const checks: Check[] = [];
  const check = (name: string, expected: unknown, actual: unknown, ok = expected === actual) => checks.push({ name, expected, actual, ok });
  check("结束原因", expect.reason, report.termination.reason);
  check("重试次数", expect.retries, report.statistics.model_requests.retries);
  const waits: number[] = [];
  for (const [round, count] of Object.entries(expect.requests).map(([r, c]) => [Number(r), c])) {
    const seen = proxy.requests.filter((r) => r.round === round);
    check(`第 ${round} 轮请求数`, count, seen.length);
    // A retry must resend the same request: nothing appended, nothing lost.
    check(`第 ${round} 轮重试请求与首次相同`, true, seen.every((r) => r.body === seen[0].body));
    const meta = JSON.parse(await fs.readFile(path.join(report.task_dir, "model", `round-${String(round).padStart(3, "0")}`, "meta.json"), "utf8"));
    check(`第 ${round} 轮 meta.json 记录的重试`, seen.length - 1, meta.retries);
    for (let i = 1; i < seen.length; i++) waits.push(seen[i].at - seen[i - 1].at);
  }
  if (expect.minWaitMs !== undefined) check("最短重试等待", `≥ ${expect.minWaitMs}ms`, `${Math.min(...waits)}ms`, Math.min(...waits) >= expect.minWaitMs);
  if (expect.maxWaitMs !== undefined) check("最长重试等待", `≤ ${expect.maxWaitMs}ms`, `${Math.max(...waits)}ms`, Math.max(...waits) <= expect.maxWaitMs);
  if (expect.matchesRecording) {
    check("状态", "passed", report.status);
    check("模型轮数", recording.rounds, report.statistics.model.rounds);
    check("token 总数（被拒的请求不计费）", recording.total_tokens, report.statistics.model.usage.total_tokens);
    const patch = await fs.readFile(path.join(report.task_dir, "changes.patch"), "utf8");
    check("改动与录制相同", true, patch === recording.patch);
  }
  return {
    scenario: scenario.name, description: scenario.description, passed: checks.every((c) => c.ok), checks,
    reason: report.termination.reason, retries: report.statistics.model_requests.retries, waits_ms: waits,
    duration_ms: Math.round(performance.now() - start), task_dir: report.task_dir,
  };
}

export interface FaultOptions {
  recordingDir: string;
  tasksDir: string;
  only?: string[];
  outDir?: string;
  quiet?: boolean;
  log?: (line: string) => void;
}

export async function runFaults(options: FaultOptions) {
  const unknown = options.only?.filter((name) => !SCENARIOS.some((s) => s.name === name)) ?? [];
  if (unknown.length) throw new Error(`没有这些故障场景：${unknown.join("、")}；可选：${SCENARIOS.map((s) => s.name).join("、")}`);
  const scenarios = options.only ? SCENARIOS.filter((s) => options.only!.includes(s.name)) : SCENARIOS;
  const log = options.log ?? ((line: string) => console.log(line));
  const recording = await loadRecording(options.recordingDir);
  const startedAt = new Date();
  const results: ScenarioResult[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const result = await runScenario(scenario, recording, options.tasksDir, options.quiet ?? true);
    results.push(result);
    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}：期望 ${c.expected}，实际 ${c.actual}`);
    log(`[${index + 1}/${scenarios.length}] ${scenario.name}：${result.passed ? "符合预期" : `不符合预期（${failed.join("；")}）`}，${(result.duration_ms / 1000).toFixed(1)} 秒`);
  }
  const summary = { started_at: startedAt.toISOString(), ended_at: new Date().toISOString(), recording: options.recordingDir,
    passed: results.filter((r) => r.passed).length, total: results.length, results };
  if (!options.outDir) return { summary, files: null };
  await fs.mkdir(options.outDir, { recursive: true });
  const stem = path.join(options.outDir, `faults-${startedAt.toISOString().replace(/[:.]/g, "-")}`);
  await fs.writeFile(`${stem}.json`, JSON.stringify(summary, null, 2) + "\n");
  await fs.writeFile(`${stem}.md`, faultsMarkdown(summary, recording));
  return { summary, files: { markdown: `${stem}.md`, json: `${stem}.json` } };
}

function faultsMarkdown(summary: { started_at: string; ended_at: string; passed: number; total: number; results: ScenarioResult[] }, recording: Recording) {
  const cell = (text: unknown) => String(text).replace(/\|/g, "\\|");
  return [
    "# ForgeAgent 故障注入评测",
    "",
    `- 时间：${summary.started_at} → ${summary.ended_at}`,
    `- 录制：${recording.task}，${recording.model}，${recording.rounds} 轮，${recording.total_tokens} tokens（回放，不调用模型）`,
    `- **符合预期 ${summary.passed}/${summary.total}**`,
    "",
    "| 场景 | 注入与预期 | 结果 | 结束原因 | 重试 | 重试前等待 | 耗时 | 不符合的检查 |",
    "|---|---|---|---|---|---|---|---|",
    ...summary.results.map((r) => `| ${r.scenario} | ${cell(r.description)} | ${r.passed ? "符合" : "**不符合**"} | ${r.reason} | ${r.retries} | ${r.waits_ms.length ? r.waits_ms.map((w) => `${w}ms`).join(" / ") : "—"} | ${(r.duration_ms / 1000).toFixed(1)}s | ${
      cell(r.checks.filter((c) => !c.ok).map((c) => `${c.name}：期望 ${c.expected}，实际 ${c.actual}`).join("；") || "—")} |`),
    "",
    "每个场景都回放同一份真实录制，故障由本地代理在指定轮次注入；被注入故障的请求不消耗录制，重试成功后模型拿到的是同一轮的回答。",
    "每次运行的完整记录见 JSON 里的 task_dir。",
    "",
  ].join("\n");
}
