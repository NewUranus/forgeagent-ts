import { promises as fs } from "node:fs";
import path from "node:path";
import { runAgent, type AgentOptions } from "../agent.js";
import { runTests, type TestConfig } from "../tools.js";
import { contextConfig } from "../config.js";

// npm run eval: run every task in eval/tasks N times and summarize pass rate and cost.
// Task layout: eval/tasks/<name>/{instruction.md, project/, task.json?}; solution/ (optional) is for
// checking the task itself and is never copied into the agent's working copy.

export interface EvalTask {
  name: string;
  /** Bug type shown in the table, from task.json. */
  category: string;
  instruction: string;
  project: string;
  /** Full-suite test command; unset means the agent's auto-detection. */
  testCommand?: string;
}

export async function loadTasks(tasksDir: string, only?: string[]): Promise<EvalTask[]> {
  const names = (await fs.readdir(tasksDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const unknown = only?.filter((name) => !names.includes(name)) ?? [];
  if (unknown.length) throw new Error(`没有这些评测任务：${unknown.join("、")}`);
  const tasks: EvalTask[] = [];
  for (const name of only ?? names) {
    const dir = path.join(tasksDir, name);
    const instruction = (await fs.readFile(path.join(dir, "instruction.md"), "utf8").catch(() => {
      throw new Error(`评测任务 ${name} 缺少 instruction.md`);
    })).trim();
    const project = path.join(dir, "project");
    if (!(await fs.stat(project).then((s) => s.isDirectory(), () => false))) throw new Error(`评测任务 ${name} 缺少 project/ 目录`);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "task.json"), "utf8").catch(() => "{}"));
    tasks.push({ name, category: meta.category ?? "", instruction, project,
      ...(typeof meta.test_command === "string" ? { testCommand: meta.test_command } : {}) });
  }
  if (!tasks.length) throw new Error(`${tasksDir} 下没有评测任务`);
  return tasks;
}

type Report = Awaited<ReturnType<typeof runAgent>>;

export interface Attempt {
  task: string;
  attempt: number;
  /** Strict pass: the agent finished as passed, the harness re-ran the full suite green, and no test file changed. */
  passed: boolean;
  status: string;
  reason: string;
  /** Independent full test run on the final working copy; null when there was no working copy to test. */
  final_tests_passed: boolean | null;
  tests_modified: boolean;
  rounds: number;
  tool_calls: number;
  total_tokens: number | null;
  /** Input and output halves of total_tokens; output is what whole-file rewrites inflate. */
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** Model turns whose request window left out older turns; 0 means context management never kicked in. */
  rounds_with_dropping: number;
  duration_ms: number;
  changed_files: string[];
  task_dir: string | null;
  error: string | null;
}

export interface TaskSummary {
  task: string;
  category: string;
  passes: number;
  attempts: number;
  avg_rounds: number;
  avg_tool_calls: number;
  /** Mean over attempts whose usage was reported; null when no attempt reported tokens (mock, replay). */
  avg_tokens: number | null;
  /** One long run can pull the mean far up; the median shows the typical run. */
  median_tokens: number | null;
  avg_prompt_tokens: number | null;
  avg_completion_tokens: number | null;
  avg_rounds_with_dropping: number;
  avg_duration_ms: number;
  /** Termination reasons of the failed attempts, e.g. { round_limit: 2 }. */
  failures: Record<string, number>;
}

export interface EvalOptions {
  tasksDir: string;
  only?: string[];
  repeat?: number;
  /** Where results go; files are named eval-<timestamp>[-label].{md,json}. */
  outDir: string;
  label?: string;
  /** Passed to every run; source, task and test command come from each task. */
  agent?: Omit<AgentOptions, "source" | "task" | "apply" | "replay" | "workspace">;
  /** Swallow the agent's console output and print one line per attempt (default true). */
  quiet?: boolean;
  log?: (line: string) => void;
}

/** Unbiased pass@k for one task with n attempts and c passes (Chen et al. 2021). */
export function passAtK(n: number, c: number, k: number) {
  if (k > n) throw new Error("k 不能大于尝试次数");
  if (n - c < k) return 1;
  let missAll = 1;
  for (let i = n - c + 1; i <= n; i++) missAll *= 1 - k / i;
  return 1 - missAll;
}

const mean = (values: number[]) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
/** Mean and median of the reported values; null when no attempt reported any (mock, replay). */
export function tokenStats(attempts: Attempt[], key: "total_tokens" | "prompt_tokens" | "completion_tokens") {
  const values = attempts.map((a) => a[key]).filter((v): v is number => v !== null);
  return values.length ? { mean: mean(values), median: median(values) } : null;
}

/** Token and context fields shared by the per-task rows and the totals. */
function costFields(attempts: Attempt[]) {
  const total = tokenStats(attempts, "total_tokens");
  return {
    avg_tokens: total?.mean ?? null,
    median_tokens: total?.median ?? null,
    avg_prompt_tokens: tokenStats(attempts, "prompt_tokens")?.mean ?? null,
    avg_completion_tokens: tokenStats(attempts, "completion_tokens")?.mean ?? null,
    avg_rounds_with_dropping: mean(attempts.map((a) => a.rounds_with_dropping)),
  };
}

export function summarizeTask(task: EvalTask, attempts: Attempt[]): TaskSummary {
  const failures: Record<string, number> = {};
  for (const a of attempts.filter((a) => !a.passed)) {
    // A run the agent called passed but the harness rejected needs its own label, or it reads as "completed".
    const why = a.status === "passed" ? (a.tests_modified ? "tests_modified" : "final_tests_failed") : a.reason;
    failures[why] = (failures[why] ?? 0) + 1;
  }
  return {
    task: task.name, category: task.category,
    passes: attempts.filter((a) => a.passed).length, attempts: attempts.length,
    avg_rounds: mean(attempts.map((a) => a.rounds)),
    avg_tool_calls: mean(attempts.map((a) => a.tool_calls)),
    ...costFields(attempts),
    avg_duration_ms: mean(attempts.map((a) => a.duration_ms)),
    failures,
  };
}

// The agent logs every model reply and the full report; across 30 runs that buries the progress lines.
export async function quietly<T>(fn: () => Promise<T>) {
  const { log, error, warn } = console;
  // Streamed model text goes straight to stdout, not through console.
  const write = process.stdout.write;
  console.log = console.error = console.warn = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { return await fn(); } finally { Object.assign(console, { log, error, warn }); process.stdout.write = write; }
}

async function runAttempt(task: EvalTask, attempt: number, options: EvalOptions): Promise<Attempt> {
  const testConfig: TestConfig = { ...options.agent?.testConfig, ...(task.testCommand ? { command: task.testCommand } : {}) };
  const start = performance.now();
  const run = () => runAgent({ ...options.agent, source: task.project, task: task.instruction, testConfig });
  let report: Report;
  try {
    report = options.quiet === false ? await run() : await quietly(run);
  } catch (error) {
    // runAgent records most failures in its report; this catches the ones before a working copy exists.
    return { task: task.name, attempt, passed: false, status: "error", reason: "eval_error", final_tests_passed: null,
      tests_modified: false, rounds: 0, tool_calls: 0, total_tokens: null, prompt_tokens: null, completion_tokens: null,
      rounds_with_dropping: 0, duration_ms: Math.round(performance.now() - start),
      changed_files: [], task_dir: null, error: String(error) };
  }
  // Re-run the suite ourselves instead of trusting the run's own verdict.
  let finalTests: boolean | null;
  try {
    const result = await runTests(report.workspace, undefined, {}, testConfig);
    finalTests = result.exit_code === 0 && !result.time_out;
  } catch { finalTests = null; }
  // Summary calls are model calls too; leave them out and llm summaries would look free.
  const { usage, summary } = report.statistics.model;
  const tokens = (key: "total_tokens" | "prompt_tokens" | "completion_tokens") =>
    usage[key] === null ? null : usage[key] + (summary.usage[key] ?? 0);
  return {
    task: task.name, attempt,
    passed: report.status === "passed" && finalTests === true && !report.changes.tests_modified,
    status: report.status, reason: report.termination.reason,
    final_tests_passed: finalTests, tests_modified: report.changes.tests_modified,
    rounds: report.statistics.model.rounds, tool_calls: report.statistics.tool_calls,
    total_tokens: tokens("total_tokens"), prompt_tokens: tokens("prompt_tokens"), completion_tokens: tokens("completion_tokens"),
    rounds_with_dropping: report.statistics.context.rounds_with_dropping,
    duration_ms: report.timing.duration_ms, changed_files: report.changed_files,
    task_dir: report.task_dir, error: report.termination.error,
  };
}

export async function runEval(options: EvalOptions) {
  const repeat = options.repeat ?? 3;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat 必须是正整数");
  const tasks = await loadTasks(options.tasksDir, options.only);
  const log = options.log ?? ((line: string) => console.log(line));
  const startedAt = new Date();
  const attempts: Attempt[] = [];
  let done = 0;
  // Sequential on purpose: parallel runs would hit provider rate limits and share the console.
  for (const task of tasks) {
    for (let i = 1; i <= repeat; i++) {
      const result = await runAttempt(task, i, options);
      attempts.push(result);
      done++;
      log(`[${done}/${tasks.length * repeat}] ${task.name} #${i}：${result.passed ? "通过" : `未通过（${result.status}/${result.reason}）`}`
        + `，${result.rounds} 轮，${result.tool_calls} 次工具调用，${result.total_tokens ?? "—"} tokens，${(result.duration_ms / 1000).toFixed(1)} 秒`);
    }
  }
  const summaries = tasks.map((task) => summarizeTask(task, attempts.filter((a) => a.task === task.name)));
  const passes = attempts.filter((a) => a.passed).length;
  const result = {
    schema_version: 2,
    label: options.label ?? null,
    started_at: startedAt.toISOString(),
    ended_at: new Date().toISOString(),
    repeat,
    // Taken from the runs, so defaults the agent filled in are recorded too.
    config: await runConfig(attempts, options),
    totals: {
      tasks: tasks.length, attempts: attempts.length, passes,
      pass_at_1: mean(summaries.map((s) => passAtK(s.attempts, s.passes, 1))),
      // pass@k with k = repeat: the share of tasks solved at least once.
      pass_at_k: { k: repeat, value: mean(summaries.map((s) => passAtK(s.attempts, s.passes, repeat))) },
      tasks_solved_once: summaries.filter((s) => s.passes > 0).length,
      ...costFields(attempts),
    },
    tasks: summaries,
    attempts,
  };
  await fs.mkdir(options.outDir, { recursive: true });
  const stem = `eval-${startedAt.toISOString().replace(/[:.]/g, "-")}${options.label ? `-${options.label.replace(/[^\w.-]+/g, "_")}` : ""}`;
  const json = path.join(options.outDir, `${stem}.json`), markdown = path.join(options.outDir, `${stem}.md`);
  await fs.writeFile(json, JSON.stringify(result, null, 2));
  await fs.writeFile(markdown, renderEval(result));
  return { result, files: { json, markdown } };
}

async function runConfig(attempts: Attempt[], options: EvalOptions) {
  const dir = attempts.find((a) => a.task_dir)?.task_dir;
  const report = dir ? JSON.parse(await fs.readFile(path.join(dir, "report.json"), "utf8")) as Report : null;
  return {
    mode: report?.task.mode ?? null,
    models: [...new Set(report?.statistics.model.models ?? [])],
    strategy: report?.task.options.strategy ?? options.agent?.strategy ?? "react",
    max_rounds: report?.task.options.max_rounds ?? options.agent?.maxRounds ?? null,
    mcp: Boolean(options.agent?.mcp),
    features: report?.task.options.features ?? options.agent?.features ?? null,
    // Context ablations shrink the window through the environment, so record what the runs used.
    context: windowSettings(),
  };
}

function windowSettings() {
  try {
    const { windowTokens, outputReserveTokens } = contextConfig();
    return { window_tokens: windowTokens, output_reserve_tokens: outputReserveTokens };
  } catch { return null; } // Invalid settings only break API runs; mock and replay never read them.
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const fixed = (value: number) => value.toFixed(1);
const count = (value: number | null) => value === null ? "—" : String(Math.round(value));

export function renderEval(result: Awaited<ReturnType<typeof runEval>>["result"]) {
  const { config, totals, repeat } = result;
  const features = config.features ? Object.entries(config.features).map(([k, v]) => `${k}=${v === true ? "on" : v === false ? "off" : v}`).join(" ") : "未知";
  const failures = (s: TaskSummary) => Object.entries(s.failures).map(([why, n]) => `${why}×${n}`).join("、") || "—";
  return [
    `# ForgeAgent 评测${result.label ? `：${result.label}` : ""}`,
    "",
    `- 时间：${result.started_at} → ${result.ended_at}`,
    `- 模式：${config.mode ?? "未知"}；模型：${config.models.join(", ") || "不适用"}；策略：${config.strategy}；最大轮数：${config.max_rounds ?? "默认"}${config.mcp ? "；MCP" : ""}`,
    `- 功能开关：${features}`,
    `- 上下文窗口：${config.context ? `${config.context.window_tokens} tokens（输出预留 ${config.context.output_reserve_tokens}）` : "配置无效"}`,
    `- 每个任务 ${repeat} 次，共 ${totals.attempts} 次运行`,
    `- **通过 ${totals.passes}/${totals.attempts}**；pass@1 = ${percent(totals.pass_at_1)}${totals.pass_at_k.k > 1 ? `；pass@${totals.pass_at_k.k} = ${percent(totals.pass_at_k.value)}` : ""}（至少通过一次的任务 ${totals.tasks_solved_once}/${totals.tasks}）`,
    `- token：平均 ${count(totals.avg_tokens)}，中位数 ${count(totals.median_tokens)}，平均输入/输出 ${count(totals.avg_prompt_tokens)} / ${count(totals.avg_completion_tokens)}；平均裁剪轮数 ${fixed(totals.avg_rounds_with_dropping)}`,
    "",
    "| 任务 | 类型 | 通过 | 平均轮数 | 平均工具调用 | 平均 token | token 中位数 | 平均输入/输出 token | 平均裁剪轮数 | 平均耗时 | 未通过原因 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...result.tasks.map((s) => `| ${s.task} | ${s.category || "—"} | ${s.passes}/${s.attempts} | ${fixed(s.avg_rounds)} | ${fixed(s.avg_tool_calls)} | ${count(s.avg_tokens)} | ${count(s.median_tokens)} | ${count(s.avg_prompt_tokens)} / ${count(s.avg_completion_tokens)} | ${fixed(s.avg_rounds_with_dropping)} | ${(s.avg_duration_ms / 1000).toFixed(1)}s | ${failures(s)} |`),
    "",
    "通过 = Agent 以 passed 结束、评测脚本独立重跑全量测试通过、且没有修改测试文件。token 含模型摘要调用；“—”表示没有可用的用量（mock/回放）。API 运行中裁剪轮数为 0，说明上下文管理没有起作用（mock/回放不裁剪）。",
    "每次运行的完整记录见 JSON 里的 task_dir。",
    "",
  ].join("\n");
}
