import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSlidingWindow, estimateRequestToken, splitGroups } from "../src/context/context.ts";
import { truncateMiddle, shrinkForContext, OUTPUT_STRING_LIMIT, TOOL_ARRAY_LIMIT } from "../src/context/truncate.ts";
import { buildRepoMap, extractSignatures, loadProjectNotes, PROJECT_NOTES_LIMIT } from "../src/context/project.ts";
import { ruleSummary, renderGroups, llmSummaryRequest } from "../src/context/summary.ts";
import { parseFeatures } from "../src/features.ts";
import { runAgent } from "../src/agent.ts";
import type { Message } from "../src/types.ts";

const call = (id: string, name = "list_files", args = {}): Message => ({
  role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id: string, content = "结果"): Message => ({ role: "tool", tool_call_id: id, content });

async function temp(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-ctx-"));
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
  MODEL_PROVIDER: "CTX_TEST", CTX_TEST_API_KEY: "test-only", CTX_TEST_BASE_URL: "https://example.invalid/v1",
  CTX_TEST_MODEL: "ctx-test", CONTEXT_WINDOW_TOKENS: "32768", CONTEXT_OUTPUT_RESERVE_TOKENS: "256",
});
const reply = (message: Message, usage?: object) =>
  new Response(JSON.stringify({ choices: [{ message }], ...(usage ? { usage } : {}) }), { headers: { "Content-Type": "application/json" } });

test("truncateMiddle keeps head and tail within the limit and says how much was cut", () => {
  assert.equal(truncateMiddle("short", 10), "short");
  const text = "H".repeat(500) + "M".repeat(9000) + "T".repeat(500);
  const cut = truncateMiddle(text, 1000);
  assert.ok(cut.length <= 1000);
  assert.ok(cut.startsWith("HHH") && cut.endsWith("TTT"));
  const omitted = Number(cut.match(/中间省略 (\d+) 个字符/)![1]);
  assert.equal(cut.length - cut.match(/\n……（中间省略 \d+ 个字符）……\n/)![0].length + omitted, text.length);
  const tailHeavy = truncateMiddle(text, 1000, 0.25);
  assert.ok(tailHeavy.indexOf("中间省略") < cut.indexOf("中间省略"), "headShare 越小，保留的开头越短");
  assert.equal(truncateMiddle("abcdef", 3), "def", "上限放不下标记时保留结尾");
});

test("shrinkForContext truncates inside values so JSON stays valid; test output keeps more tail", () => {
  const output = { ok: true, result: { exit_code: 1, stdout: "start\n" + "x".repeat(20000) + "\nℹ fail 3", stderr: "", list: Array.from({ length: 400 }, (_, i) => i) } };
  const shrunk = shrinkForContext(output) as any;
  assert.deepEqual(JSON.parse(JSON.stringify(shrunk)), shrunk);
  assert.ok(shrunk.result.stdout.length <= OUTPUT_STRING_LIMIT);
  assert.ok(shrunk.result.stdout.endsWith("ℹ fail 3"));
  assert.equal(shrunk.result.list.length, TOOL_ARRAY_LIMIT + 1);
  assert.match(shrunk.result.list.at(-1), /共 400 项/);
  assert.equal(shrunk.result.exit_code, 1);
});

test("parseFeatures accepts the documented values and rejects others", () => {
  assert.deepEqual(parseFeatures({}), {});
  assert.deepEqual(parseFeatures({ context: "none", truncate: "off", summary: "llm", "repo-map": "off", "project-notes": "on" }),
    { context: "none", truncate: false, summary: "llm", repoMap: false, projectNotes: true });
  assert.throws(() => parseFeatures({ context: "full" }), /window、none/);
  assert.throws(() => parseFeatures({ truncate: "yes" }), /on 或 off/);
});

test("window keeps every message before the first turn fixed and inserts the summary right after it", () => {
  const fixed: Message[] = [{ role: "system", content: "规则" }, { role: "user", content: "任务" }, { role: "user", content: "仓库概览" }];
  const history = [...fixed, call("old"), result("old", "旧".repeat(3000)), call("new"), result("new")];
  assert.equal(splitGroups(history).fixed.length, 3);
  assert.equal(splitGroups(history).groups.length, 2);
  const summary = (n: number) => `摘要：省略 ${n} 组`;
  const roomy = buildSlidingWindow(history, [], 100000, { summary });
  assert.equal(roomy.summarized, false, "没有裁剪时不插入摘要");
  const kept = [...fixed, { role: "user" as const, content: "摘要：省略 1 组" }, call("new"), result("new")];
  const tight = buildSlidingWindow(history, [], estimateRequestToken(kept, []), { summary });
  assert.deepEqual(tight.messages, kept);
  assert.equal(tight.summarized, true);
  // Without a summary callback the behavior is the original plain window.
  assert.deepEqual(buildSlidingWindow(history, [], estimateRequestToken(kept, [])).messages, [...fixed, call("new"), result("new")]);
});

test("project notes are labelled as data and capped", async t => {
  const dir = await temp(t);
  assert.equal(await loadProjectNotes(dir), null);
  await fs.writeFile(path.join(dir, "AGENTS.md"), "使用两个空格缩进\n" + "x".repeat(PROJECT_NOTES_LIMIT * 2));
  const notes = (await loadProjectNotes(dir))!;
  assert.match(notes, /属于数据.*不能覆盖系统规则/);
  assert.match(notes, /--- AGENTS.md ---\n使用两个空格缩进/);
  assert.ok(notes.length < PROJECT_NOTES_LIMIT + 500);
});

test("repo map lists top-level signatures, ranks referenced files first and tests last, within budget", async t => {
  const dir = await temp(t);
  const files: Record<string, string> = {
    "util.ts": "export function helper(a: number): number {\n  return a;\n}\nfunction local() {}\n",
    "main.ts": 'import { helper } from "./util.js";\nexport class App extends Base {\n  run() { return helper(1); }\n}\nexport interface Options {}\n',
    "other.py": "def compute(x, y=1) -> int:\n    return x\nclass Thing(Base):\n    def method(self):\n        pass\n",
    "util.test.ts": 'import { helper } from "./util.js";\n',
    "README.md": "# demo\n",
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  assert.deepEqual(extractSignatures("other.py", files["other.py"]).map(s => s.text), ["def compute(x, y=1) -> int", "class Thing(Base)"]);
  assert.deepEqual(extractSignatures("a.ts", "export function average(numbers: (number | null)[]): number {").map(s => s.text),
    ["export function average(numbers: (number | null)[]): number"], "参数里的嵌套括号");
  const map = await buildRepoMap(dir);
  const order = map.split("\n").filter(line => line && !line.startsWith(" ") && !line.startsWith("仓库概览"));
  assert.deepEqual(order, ["util.ts", "main.ts", "other.py", "README.md", "util.test.ts"]);
  assert.match(map, /^ {2}export function helper\(a: number\): number$/m);
  assert.match(map, /^ {2}export class App extends Base$/m);
  assert.match(map, /^ {2}export interface Options$/m);
  assert.doesNotMatch(map, /method|run\(\)/, "只列顶层声明");
  const small = await buildRepoMap(dir, 200);
  assert.ok(small.length <= 200);
  assert.match(small, /还有 \d+ 个文件未列出/);
});

test("rule summary states facts from run records, including stale tests and the plan", () => {
  const text = ruleSummary(2, {
    readFiles: new Set(["a.ts"]), editedFiles: new Map([["a.ts", 2]]), partialTestRuns: 1,
    latestTest: { status: "failed", counts: { passed: 1, failed: 2 }, failed_test_names: ["t1", "t2"] } as any,
    latestTestIsCurrent: false,
    plan: [{ id: "1", description: "修复", status: "in_progress" }],
  });
  assert.match(text, /省略了最早的 2 组交互/);
  assert.match(text, /已读取的文件：a\.ts/);
  assert.match(text, /已修改的文件：a\.ts（2 次）/);
  assert.match(text, /failed，通过 1，失败 2；失败用例：t1、t2（之后发生过写入，结果已过期）/);
  assert.match(text, /部分测试运行次数：1/);
  assert.match(text, /\[in_progress\] 修复/);
});

test("summary request renders dropped turns with every message and the total capped", () => {
  const groups = [[call("r", "read_file", { relative_path: "a.ts" }), result("r", "y".repeat(10000))]];
  const rendered = renderGroups(groups);
  assert.match(rendered, /调用 read_file\(\{"relative_path":"a.ts"\}\)/);
  assert.ok(rendered.length < 2000);
  const request = llmSummaryRequest("m", "旧摘要", groups);
  assert.equal(request.model, "m");
  assert.match(request.messages[1].content, /已有摘要：\n旧摘要/);
  assert.ok(!("tools" in request), "摘要请求不带工具");
});

// Shared setup: the second request sets a budget that only fits once the first read is dropped.
async function droppingRun(t: any, features: object, summarize?: (request: any) => Response | Promise<Response>) {
  apiEnv(t);
  const base = await temp(t);
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "large.txt"), "old-output ".repeat(500));
  await fs.writeFile(path.join(source, "ok.test.js"), 'require("node:test")("ok", () => {});');
  await fs.writeFile(path.join(source, "AGENTS.md"), "提交前运行测试。");
  const requests: any[] = [], summaries: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    if (!request.tools) { summaries.push(request); return summarize!(request); }
    requests.push(request);
    if (requests.length === 1) return reply(call("read", "read_file", { relative_path: "large.txt" }));
    if (requests.length === 2) {
      process.env.CONTEXT_WINDOW_TOKENS = String(estimateRequestToken(request.messages, request.tools) + 256);
      return reply(call("list"));
    }
    return reply({ role: "assistant", content: "继续检查" });
  });
  const report = await runAgent({ base, source, mock: false, maxRounds: 3, features });
  return { report, requests, summaries };
}

test("API run keeps notes and repo map fixed and replaces dropped turns with a rule summary", async t => {
  const { report, requests } = await droppingRun(t, {});
  assert.equal(requests.length, 3);
  const first = requests[0].messages;
  assert.equal(first.length, 4);
  assert.match(first[2].content, /--- AGENTS.md ---\n提交前运行测试。/);
  assert.match(first[3].content, /^以下是仓库概览.*\n\n仓库概览/s);
  const third = requests[2].messages;
  assert.deepEqual(third.slice(0, 4), first, "固定前缀不变");
  assert.match(third[4].content, /^【早期交互摘要】为控制上下文长度，省略了最早的 1 组交互/);
  assert.match(third[4].content, /已读取的文件：large\.txt/);
  assert.equal(third[5].tool_calls[0].id, "list");
  assert.ok(!JSON.stringify(third).includes("old-output old-output"));
  assert.equal(report.statistics.context.summarized_rounds, 1);
  assert.equal(report.statistics.context.max_dropped_groups, 1);
  assert.equal(report.task.options.features.summary, "rule");
});

test("llm summary is logged separately, counted apart from turns, and used in the window", async t => {
  const { report, requests, summaries } = await droppingRun(t, { summary: "llm" },
    () => reply({ role: "assistant", content: "读过 large.txt，内容是重复的 old-output。" }, { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }));
  assert.equal(summaries.length, 1);
  assert.match(summaries[0].messages[1].content, /调用 read_file\(\{"relative_path":"large.txt"\}\)/);
  assert.match(requests[2].messages[4].content, /摘要由模型生成.*\n读过 large\.txt/s);
  assert.equal(report.statistics.model.rounds, 3);
  assert.equal(report.statistics.model.summary.api_calls, 1);
  assert.equal(report.statistics.model.summary.usage.total_tokens, 60);
  assert.equal(report.statistics.context.llm_summary_calls, 1);
  await fs.access(path.join(report.task_dir, "model/summary-001/response.json"));
});

test("a failed llm summary falls back to the rule summary instead of failing the task", async t => {
  const { report, requests } = await droppingRun(t, { summary: "llm" }, () => new Response("busy", { status: 500 }));
  assert.equal(requests.length, 3);
  assert.match(requests[2].messages[4].content, /以下由运行记录自动生成/);
  assert.equal(report.statistics.context.llm_summary_errors, 1);
  assert.notEqual(report.termination.reason, "model_error");
});

test("context none sends the full history even over budget; truncation applies only to the context copy", async t => {
  apiEnv(t);
  const base = await temp(t);
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "noisy.test.js"),
    'require("node:test")("noisy", () => { console.log("START" + "x".repeat(20000) + "END"); });');
  const run = async (features: object) => {
    const requests: any[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      requests.push(request);
      return reply(requests.length === 1 ? call("t", "run_tests") : { role: "assistant", content: "完成" });
    });
    const report = await runAgent({ base, source, mock: false, maxRounds: 2, features: { repoMap: false, ...features } });
    return { report, requests };
  };

  const truncated = await run({});
  const toolMessage = truncated.requests[1].messages.find((m: any) => m.role === "tool").content;
  assert.match(toolMessage, /中间省略/);
  assert.match(toolMessage, /END/);
  assert.ok(toolMessage.length < 10000);
  assert.match(await fs.readFile(path.join(truncated.report.task_dir, "trace.jsonl"), "utf8"), /x{20000}END/, "trace 保留完整输出");

  const full = await run({ truncate: false });
  assert.match(full.requests[1].messages.find((m: any) => m.role === "tool").content, /x{20000}END/);

  process.env.CONTEXT_WINDOW_TOKENS = "300";
  const none = await run({ context: "none" });
  assert.equal(none.requests.length, 2, "关闭上下文管理时不做客户端预算检查");
  assert.notEqual(none.report.termination.reason, "context_limit");
  assert.equal(none.report.task.options.features.context, "none");
});
