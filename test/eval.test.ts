import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTasks, passAtK, runEval } from "../src/eval/run.ts";
import { runTests } from "../src/tools.ts";
import type { Message } from "../src/types.ts";

const TASKS = new URL("../eval/tasks/", import.meta.url).pathname;

async function temp(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A task that cannot fail before the fix or still fails after it measures nothing.
test("every eval task fails as shipped and passes with its reference solution", async t => {
  const tasks = await loadTasks(TASKS);
  assert.ok(tasks.length >= 10);
  for (const task of tasks) {
    assert.ok(task.instruction.length > 0 && task.category, `${task.name} 缺少说明或类型`);
    const dir = path.join(await temp(t), "project");
    await fs.cp(task.project, dir, { recursive: true });
    const before = await runTests(dir, undefined, {}, { command: task.testCommand });
    assert.notEqual(before.exit_code, 0, `${task.name} 修复前测试就通过了`);
    await fs.cp(path.join(TASKS, task.name, "solution"), dir, { recursive: true });
    const after = await runTests(dir, undefined, {}, { command: task.testCommand });
    assert.equal(after.exit_code, 0, `${task.name} 参考答案没有通过：\n${after.stdout}\n${after.stderr}`);
  }
});

test("loadTasks validates layout and filters", async t => {
  const root = await temp(t);
  await fs.mkdir(path.join(root, "a", "project"), { recursive: true });
  await fs.writeFile(path.join(root, "a", "instruction.md"), "修好它\n");
  await fs.writeFile(path.join(root, "a", "task.json"), JSON.stringify({ category: "x", test_command: "true" }));
  await fs.mkdir(path.join(root, "b", "project"), { recursive: true });
  await assert.rejects(loadTasks(root), /b 缺少 instruction\.md/);
  assert.deepEqual((await loadTasks(root, ["a"])).map(t => [t.name, t.category, t.instruction, t.testCommand]), [["a", "x", "修好它", "true"]]);
  await assert.rejects(loadTasks(root, ["nope"]), /没有这些评测任务：nope/);
});

test("passAtK matches the unbiased estimator", () => {
  assert.equal(passAtK(3, 0, 1), 0);
  assert.ok(Math.abs(passAtK(3, 1, 1) - 1 / 3) < 1e-12);
  assert.equal(passAtK(3, 1, 3), 1);
  assert.ok(Math.abs(passAtK(5, 2, 2) - 0.7) < 1e-12); // 1 - C(3,2)/C(5,2)
  assert.throws(() => passAtK(2, 1, 3));
});

const call = (name: string, args: unknown): Message => ({ role: "assistant", content: null,
  tool_calls: [{ id: `c_${name}_${Math.random()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const plan = (status: string) => call("update_plan", { steps: [{ id: "s1", description: "修复", status }] });

test("runEval runs every attempt, survives failures, and writes the summary", async t => {
  const root = await temp(t), tasksDir = path.join(root, "tasks"), base = path.join(root, "base");
  const task = async (name: string, instruction: string) => {
    await fs.mkdir(path.join(tasksDir, name, "project"), { recursive: true });
    await fs.writeFile(path.join(tasksDir, name, "instruction.md"), instruction);
    await fs.writeFile(path.join(tasksDir, name, "task.json"), JSON.stringify({ category: "演示" }));
    await fs.writeFile(path.join(tasksDir, name, "project", "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(tasksDir, name, "project", "add.ts"), "export const add = (a: number, b: number) => a - b;\n");
    await fs.writeFile(path.join(tasksDir, name, "project", "add.test.ts"),
      'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "./add.ts";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  };
  await task("fixable", "修复 add");
  await task("broken", "模型会出错");
  // Scripted model: the reply depends on how far this conversation got, so each attempt starts over.
  const reply = async (messages: Message[]) => {
    if (messages[1].content === "模型会出错") throw new Error("模拟模型故障");
    const turn = messages.filter(m => m.role === "assistant").length;
    return [
      plan("in_progress"),
      call("write_file", { relative_path: "add.ts", content: "export const add = (a: number, b: number) => a + b;\n" }),
      call("run_tests", {}),
      plan("completed"),
    ][turn] ?? { role: "assistant", content: "完成" };
  };
  const lines: string[] = [];
  const { result, files } = await runEval({ tasksDir, repeat: 2, outDir: path.join(root, "out"), label: "demo run",
    agent: { base, reply, maxRounds: 6, features: { repoMap: false } }, log: line => lines.push(line) });

  assert.equal(lines.length, 4);
  assert.deepEqual(result.attempts.map(a => [a.task, a.attempt, a.passed]), [["broken", 1, false], ["broken", 2, false], ["fixable", 1, true], ["fixable", 2, true]]);
  const fixed = result.attempts.find(a => a.task === "fixable")!;
  assert.equal(fixed.final_tests_passed, true);
  assert.deepEqual(fixed.changed_files, ["add.ts"]);
  assert.ok(fixed.rounds >= 5 && fixed.tool_calls === 4 && fixed.total_tokens === null);
  const broken = result.tasks.find(s => s.task === "broken")!;
  assert.deepEqual(broken.failures, { model_error: 2 });
  assert.equal(result.totals.passes, 2);
  assert.equal(result.totals.pass_at_1, 0.5);
  assert.deepEqual(result.totals.pass_at_k, { k: 2, value: 0.5 });
  assert.equal(result.config.mode, "custom");
  assert.equal(result.config.features?.repoMap, false);

  assert.match(path.basename(files.json), /^eval-.*-demo_run\.json$/);
  assert.deepEqual(JSON.parse(await fs.readFile(files.json, "utf8")), result);
  const markdown = await fs.readFile(files.markdown, "utf8");
  assert.match(markdown, /\| fixable \| 演示 \| 2\/2 \|/);
  assert.match(markdown, /\| broken \| 演示 \| 0\/2 \| .* \| model_error×2 \|/);
  assert.match(markdown, /通过 2\/4/);
});

test("an agent verdict of passed is not enough when the final suite fails", async t => {
  const root = await temp(t), tasksDir = path.join(root, "tasks");
  await fs.mkdir(path.join(tasksDir, "flaky", "project"), { recursive: true });
  await fs.writeFile(path.join(tasksDir, "flaky", "instruction.md"), "跑测试");
  // Baseline and the agent's run pass, the third run fails: the agent sees green, the independent re-run does not.
  await fs.writeFile(path.join(tasksDir, "flaky", "task.json"), JSON.stringify({ test_command: 'n=$(cat runs 2>/dev/null || echo 0); echo $((n + 1)) > runs; [ "$n" -lt 2 ]' }));
  await fs.writeFile(path.join(tasksDir, "flaky", "project", "a.txt"), "x");
  const turns = [plan("in_progress"), call("run_tests", {}), plan("completed")];
  const { result } = await runEval({ tasksDir, repeat: 1, outDir: path.join(root, "out"), log: () => {},
    agent: { base: path.join(root, "base"), reply: async m => turns[m.filter(x => x.role === "assistant").length] ?? { role: "assistant", content: "完成" }, features: { repoMap: false } } });
  const [attempt] = result.attempts;
  assert.equal(attempt.status, "passed");
  assert.equal(attempt.final_tests_passed, false);
  assert.equal(attempt.passed, false);
  assert.deepEqual(result.tasks[0].failures, { final_tests_failed: 1 });
});
