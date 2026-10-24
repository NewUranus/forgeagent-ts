import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parsePlan } from "../src/strategy/plan-execute.ts";
import { runAgent } from "../src/agent.ts";
import type { Message } from "../src/types.ts";

let ids = 0;
const call = (name: string, args = {}): Message => ({ role: "assistant", content: null,
  tool_calls: [{ id: `c${++ids}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const say = (content: string): Message => ({ role: "assistant", content });
const step = (id: string, goal: string, verify: string) => ({ id, goal, done_when: `${goal}完成`, verify });
const fix = call("edit_file", { relative_path: "answer.js", old_str: "= 0", new_str: "= 42" });

async function fixture(t: any) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-plan-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(source, "answer.js"), "export const answer = 0;\n");
  await fs.writeFile(path.join(source, "answer.test.js"),
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { answer } from "./answer.js"; test("answer is 42", () => assert.equal(answer, 42));');
  await fs.writeFile(path.join(source, "other.test.js"), 'import { test } from "node:test"; test("other", () => {});');
  return { base, source };
}

type Role = "planner" | "replanner" | "executor";
/** A scripted model: replies are queued per role, and per step for the executor. */
function script(plan: { planner?: Message[]; replanner?: Message[]; executor?: Record<string, Message[]> }) {
  const seen: { role: Role; step: string | null; messages: Message[] }[] = [];
  const reply = async (messages: Message[]) => {
    const system = String(messages[0].content);
    const role: Role = system.startsWith("你是规划者") ? "planner" : system.startsWith("你是重新规划者") ? "replanner" : "executor";
    const brief = messages.map(m => m.content ?? "").join("\n");
    const current = role === "executor" ? brief.match(/当前步骤 (\S+?)：/)?.[1] ?? null : null;
    seen.push({ role, step: current, messages: structuredClone(messages) });
    const queue = role === "executor" ? plan.executor?.[current!] : plan[role];
    return queue?.shift() ?? say("（脚本已用完）");
  };
  return { reply, seen };
}
const run = (fx: { base: string; source: string }, s: ReturnType<typeof script>, extra = {}) =>
  runAgent({ base: fx.base, source: fx.source, reply: s.reply, strategy: "plan-execute", features: { repoMap: false }, ...extra });

test("parsePlan validates fields, verify rules, step count and id collisions", () => {
  const ok = parsePlan({ steps: [step("a", "修复", "tests:a.test.js"), step("b", "验证", "full_tests")] }, 8);
  assert.deepEqual(ok.map(s => [s.id, s.verify, s.status]), [["a", "tests:a.test.js", "pending"], ["b", "full_tests", "pending"]]);
  assert.throws(() => parsePlan({ steps: [] }, 8), /非空数组/);
  assert.throws(() => parsePlan({ steps: [step("a", "x", "maybe")] }, 8), /verify 只能是/);
  assert.throws(() => parsePlan({ steps: [step("a", "x", "none"), step("a", "y", "none")] }, 8), /重复/);
  assert.throws(() => parsePlan({ steps: [step("a", "x", "none")] }, 8, new Set(["a"])), /已完成步骤重复/);
  assert.throws(() => parsePlan({ steps: [step("a", "x", "none"), step("b", "y", "none")] }, 1), /最多 1 步/);
  assert.throws(() => parsePlan({ steps: [{ id: "a", goal: "", done_when: "x", verify: "none" }] }, 8), /缺少 goal/);
});

test("planner explores read-only, executor works step by step with only handoffs, harness accepts each step", async t => {
  const fx = await fixture(t);
  const s = script({
    planner: [
      call("read_file", { relative_path: "answer.js" }),
      call("submit_plan", { steps: [step("fix", "把 answer 改成 42", "tests:answer.test.js"), step("check", "全量验证", "full_tests")] }),
    ],
    executor: { fix: [fix, call("complete_step", { summary: "answer.js 改为 42" })], check: [call("complete_step", { summary: "全量测试通过" })] },
  });
  const report = await run(fx, s);
  assert.equal(report.status, "passed");
  assert.equal(report.termination.reason, "completed");
  assert.equal(report.termination.verified, true);
  const stats = report.statistics.plan_execute!;
  assert.deepEqual(stats.steps.map(x => [x.id, x.status, x.verify_attempts]), [["fix", "completed", 1], ["check", "completed", 1]]);
  assert.equal(stats.plan_versions, 1);
  assert.equal(stats.replans, 0);

  // The second executor sees the first step only through its handoff, not its transcript.
  const check = s.seen.find(x => x.step === "check")!.messages;
  const text = JSON.stringify(check);
  assert.match(text, /fix（把 answer 改成 42）：answer.js 改为 42；改动文件：answer.js；验收：tests:answer.test.js 通过/);
  assert.ok(!text.includes("edit_file\",\"arguments"), "没有带上一步的工具调用记录");
  assert.match(text, /\[x\] fix：/);

  const phases = report.tests.runs.map((r: any) => `${r.phase}:${r.scope}`);
  assert.deepEqual(phases, ["baseline:full", "verify:partial", "verify:full", "verify:full"], "两次步骤验收 + 最终检查，都由程序执行");
  const plan = JSON.parse(await fs.readFile(path.join(report.task_dir, "plan.json"), "utf8"));
  assert.deepEqual(plan.steps.map((x: any) => x.status), ["completed", "completed"]);
  assert.equal(report.statistics.model.rounds, s.seen.length, "所有角色的模型调用共用一个连续编号");
  assert.equal(report.task.options.strategy, "plan-execute");
});

test("the planner cannot write and must resubmit an invalid plan", async t => {
  const fx = await fixture(t);
  const s = script({
    planner: [
      fix,
      call("submit_plan", { steps: [step("fix", "修复", "sometimes")] }),
      call("submit_plan", { steps: [step("fix", "修复", "full_tests")] }),
    ],
    executor: { fix: [fix, call("complete_step", { summary: "已修复" })] },
  });
  const report = await run(fx, s);
  assert.equal(report.status, "passed");
  const planner = s.seen.filter(x => x.role === "planner");
  assert.match(JSON.stringify(planner[1].messages.at(-1)), /规划阶段只能使用只读工具，不能调用 edit_file/);
  assert.match(JSON.stringify(planner[2].messages.at(-1)), /计划无效.*verify 只能是/);
});

test("a failed acceptance is fed back once; the executor fixes it and the step passes on the second check", async t => {
  const fx = await fixture(t);
  const s = script({
    planner: [call("submit_plan", { steps: [step("fix", "修复 answer", "full_tests")] })],
    executor: { fix: [call("complete_step", { summary: "我觉得好了" }), fix, call("complete_step", { summary: "改成 42" })] },
  });
  const report = await run(fx, s);
  assert.equal(report.status, "passed");
  assert.equal(report.statistics.plan_execute!.steps[0].verify_attempts, 2);
  const third = s.seen.filter(x => x.step === "fix")[1].messages;
  assert.match(String(third.at(-1)!.content), /验收未通过（full_tests）[\s\S]*answer is 42/);
});

test("a blocked step triggers a replan that keeps completed steps and continues", async t => {
  const fx = await fixture(t);
  const s = script({
    planner: [call("submit_plan", { steps: [step("look", "阅读代码", "none"), step("wrong", "改 other.js", "full_tests")] })],
    executor: {
      look: [call("complete_step", { summary: "问题在 answer.js" })],
      wrong: [call("report_blocked", { reason: "other.js 不存在，问题在 answer.js" })],
      fix2: [fix, call("complete_step", { summary: "answer.js 改为 42" })],
    },
    replanner: [call("submit_plan", { steps: [step("fix2", "修复 answer.js", "full_tests")] })],
  });
  const report = await run(fx, s);
  assert.equal(report.status, "passed");
  const stats = report.statistics.plan_execute!;
  assert.equal(stats.replans, 1);
  assert.equal(stats.plan_versions, 2);
  const replanner = JSON.stringify(s.seen.find(x => x.role === "replanner")!.messages);
  assert.match(replanner, /步骤 wrong 受阻：other.js 不存在/);
  assert.match(replanner, /look（阅读代码）：问题在 answer.js/);
  const plan = JSON.parse(await fs.readFile(path.join(report.task_dir, "plan.json"), "utf8"));
  assert.deepEqual(plan.steps.map((x: any) => [x.id, x.status]), [["look", "completed"], ["fix2", "completed"]]);
});

test("when every step passes but the final check fails, the run replans instead of claiming success", async t => {
  const fx = await fixture(t);
  const s = script({
    planner: [call("submit_plan", { steps: [step("read", "只读分析", "none")] })],
    executor: { read: [call("complete_step", { summary: "看过了" })], fix: [fix, call("complete_step", { summary: "已修复" })] },
    replanner: [call("submit_plan", { steps: [step("fix", "修复 answer", "full_tests")] })],
  });
  const report = await run(fx, s);
  assert.equal(report.status, "passed");
  assert.equal(report.statistics.plan_execute!.final_checks, 2);
  assert.match(JSON.stringify(s.seen.find(x => x.role === "replanner")!.messages), /所有步骤都已完成，但最终检查未通过：全量测试未通过/);
});

test("limits end the run with distinct reasons: replan_limit, planning_failed, round_limit", async t => {
  const blocked = script({
    planner: [call("submit_plan", { steps: [step("a", "x", "none")] })],
    executor: { a: [call("report_blocked", { reason: "做不了" })] },
  });
  const r1 = await run(await fixture(t), blocked, { planLimits: { maxReplans: 0 } });
  assert.deepEqual([r1.status, r1.termination.reason], ["failed", "replan_limit"]);

  const silent = script({ planner: [say("我想想"), say("还在想")] });
  const r2 = await run(await fixture(t), silent, { planLimits: { plannerRounds: 2 } });
  assert.deepEqual([r2.status, r2.termination.reason], ["failed", "planning_failed"]);

  const slow = script({
    planner: [call("submit_plan", { steps: [step("a", "x", "full_tests")] })],
    executor: { a: Array.from({ length: 10 }, () => call("list_files")) },
  });
  const r3 = await run(await fixture(t), slow, { maxRounds: 3, features: { repoMap: false, loopGuard: false } });
  assert.deepEqual([r3.status, r3.termination.reason], ["limit_reached", "round_limit"]);
  assert.equal(r3.statistics.model.rounds, 3);
});
