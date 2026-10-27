import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseAgentArgs, SUBAGENT_HINT } from "../src/subagents.ts";
import { runAgent } from "../src/agent.ts";
import type { Message } from "../src/types.ts";

let ids = 0;
const calls = (...list: [string, object?][]): Message => ({ role: "assistant", content: null,
  tool_calls: list.map(([name, args = {}]) => ({ id: `c${++ids}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })) });
const call = (name: string, args = {}) => calls([name, args]);
const say = (content: string): Message => ({ role: "assistant", content });
const done = call("update_plan", { steps: [{ id: "s1", description: "修复", status: "completed" }] });
const fix = call("edit_file", { relative_path: "answer.js", old_str: "= 0", new_str: "= 42" });
const explore = (task: string) => ["agent", { type: "explore", task }] as [string, object];

async function fixture(t: any) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-sub-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(source, "answer.js"), "export const answer = 0;\n");
  await fs.writeFile(path.join(source, "answer.test.js"),
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { answer } from "./answer.js"; test("answer is 42", () => assert.equal(answer, 42));');
  return { base, source };
}

type Role = "main" | "explore" | "verify";
/** A scripted model: replies are queued per role, told apart by the system prompt. */
function script(queues: Partial<Record<Role, Message[]>>) {
  const seen: { role: Role; messages: Message[] }[] = [];
  const reply = async (messages: Message[]) => {
    const system = String(messages[0].content);
    const role: Role = system.startsWith("你是只读的代码调查") ? "explore" : system.startsWith("你是只读的测试分析") ? "verify" : "main";
    seen.push({ role, messages: structuredClone(messages) });
    return queues[role]?.shift() ?? say("（脚本已用完）");
  };
  return { reply, seen, last: (role: Role) => seen.filter((x) => x.role === role).at(-1)!.messages };
}
const run = (fx: { base: string; source: string }, s: ReturnType<typeof script>, extra: object = {}) =>
  runAgent({ base: fx.base, source: fx.source, reply: s.reply, features: { repoMap: false, subagents: true }, ...extra });
const toolResults = (messages: Message[]) => messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content!));

test("parseAgentArgs validates type and task", () => {
  assert.equal(parseAgentArgs('{"type":"explore","task":"  找入口  "}').task, "找入口");
  assert.throws(() => parseAgentArgs('{"type":"writer","task":"x"}'), /type 只能是 explore、verify/);
  assert.throws(() => parseAgentArgs('{"type":"explore","task":" "}'), /task 不能为空/);
  assert.throws(() => parseAgentArgs("[]"), /必须是对象/);
});

test("the main agent delegates an investigation and gets only the report back", async (t) => {
  const fx = await fixture(t);
  const read = call("read_file", { relative_path: "answer.js" });
  const s = script({
    main: [done, calls(explore("answer.js 里 answer 的值是多少？测试期望多少？")), fix, call("run_tests"), say("完成")],
    explore: [read, say("answer.js:1 answer = 0；answer.test.js 期望 42")],
  });
  const report = await run(fx, s);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.statistics.subagents, { runs: [{ agent_id: "sub_1", type: "explore", status: "completed", rounds: 2, tool_calls: 1 }] });

  // The sub-agent starts fresh: its own role and the brief, nothing from the main conversation.
  const first = s.seen.find((x) => x.role === "explore")!.messages;
  assert.equal(first.length, 2);
  assert.equal(first[1].content, "answer.js 里 answer 的值是多少？测试期望多少？");
  assert.doesNotMatch(JSON.stringify(first), /检查项目，修复导致测试失败的问题/);

  // The main agent sees the report, never the file the sub-agent read.
  const main = s.last("main");
  const delegated = toolResults(main).find((r) => r.result?.agent_id === "sub_1");
  assert.equal(delegated.result.report, "answer.js:1 answer = 0；answer.test.js 期望 42");
  assert.ok(!main.some((m) => m.tool_call_id === read.tool_calls![0].id));
  assert.match(String(main[0].content), new RegExp(SUBAGENT_HINT));

  const trace = (await fs.readFile(path.join(report.task_dir, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(trace.some((x) => x.agent === "sub_1" && x.tool === "read_file"));
  assert.ok(trace.some((x) => x.tool === "agent" && x.output.result.status === "completed"));
});

test("a sub-agent is held to its whitelist and cannot delegate again", async (t) => {
  const fx = await fixture(t);
  const s = script({
    main: [calls(explore("把 answer 改成 42"))],
    explore: [fix, call("agent", { type: "explore", task: "替我改" }), say("我没有写入权限")],
  });
  const report = await run(fx, s, { maxRounds: 1 });
  assert.equal(await fs.readFile(path.join(report.workspace, "answer.js"), "utf8"), "export const answer = 0;\n");
  const errors = toolResults(s.last("explore")).map((r) => r.error);
  assert.deepEqual(errors, ["Error: 子 agent 不能使用 edit_file", "Error: 子 agent 不能使用 agent"]);
  assert.equal(report.statistics.subagents!.runs[0].status, "completed");
});

test("at most three sub-agents per turn, and every result stays paired with its call in order", async (t) => {
  const fx = await fixture(t);
  const turn = calls(explore("问题一"), ["list_files"], explore("问题二"), explore("问题三"), explore("问题四"));
  const s = script({ main: [turn], explore: [say("报告一"), say("报告二"), say("报告三")] });
  const report = await run(fx, s, { maxRounds: 2 });
  assert.deepEqual(report.statistics.subagents!.runs.map((r) => r.agent_id), ["sub_1", "sub_2", "sub_3"]);
  // The next main turn carries one result per call, in the order of the calls.
  const main = s.last("main");
  const answered = main.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(answered, turn.tool_calls!.map((c) => c.id));
  const trace = (await fs.readFile(path.join(report.task_dir, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const byCall = new Map(trace.map((x) => [x.tool_call_id, x]));
  const outputs = turn.tool_calls!.map((c) => byCall.get(c.id)!.output);
  assert.deepEqual(outputs.map((o) => o.ok), [true, true, true, true, false]);
  assert.match(outputs[4].error, /同一轮最多派出 3 个子 agent/);
  assert.deepEqual([outputs[0], outputs[2], outputs[3]].map((o) => o.result.report), ["报告一", "报告二", "报告三"]);
});

test("a sub-agent that never concludes stops at its round limit; one that repeats itself is stopped early", async (t) => {
  const fx = await fixture(t);
  const wander = Array.from({ length: 8 }, (_, i) => call("find_files", { pattern: `*.${i}` }));
  const same = () => call("read_file", { relative_path: "answer.js" });
  const s = script({
    main: [calls(explore("随便看看")), calls(["agent", { type: "verify", task: "为什么失败" }])],
    explore: wander,
    verify: [same(), same(), same()],
  });
  const report = await run(fx, s, { maxRounds: 2 });
  assert.deepEqual(report.statistics.subagents!.runs.map((r) => [r.type, r.status, r.rounds]), [["explore", "round_limit", 8], ["verify", "loop_detected", 3]]);
  // The main agent's own loop guard never saw the sub-agents' calls.
  assert.deepEqual(report.statistics.loop.detections, []);
});

test("without the switch the agent tool is refused and the prompt is unchanged", async (t) => {
  const fx = await fixture(t);
  const s = script({ main: [calls(explore("看看"))] });
  const report = await run(fx, s, { maxRounds: 1, features: { repoMap: false } });
  assert.equal(report.statistics.subagents, null);
  assert.doesNotMatch(String(s.seen[0].messages[0].content), /agent 工具/);
  const trace = (await fs.readFile(path.join(report.task_dir, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(trace[0].output.error, "Error: 未知工具：agent");
});

test("sub-agents work only with the react strategy", async () => {
  await assert.rejects(runAgent({ strategy: "plan-execute", features: { subagents: true }, reply: async () => say("x") }), /subagents 只支持 react 策略/);
});
