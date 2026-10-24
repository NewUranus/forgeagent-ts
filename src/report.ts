import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { diffLines } from "diff";
import { listFiles, type FileChange } from "./workspace.js";
import { isTestConfig, isTestFile } from "./guard.js";
import type { TestResult } from "./types.js";

/** Hash the copied inputs, before tests can create output files. Exclusions match workspace copying. */
export async function fingerprint(root: string) {
  const hash = createHash("sha256");
  const files = await listFiles(root);
  for (const file of files) {
    const digest = createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex");
    hash.update(JSON.stringify([file, digest]) + "\n");
  }
  return { algorithm: "sha256", value: hash.digest("hex"), file_count: files.length };
}

export async function readPlanProgress(taskDir: string) {
  try {
    const plan = JSON.parse(await fs.readFile(path.join(taskDir, "plan.json"), "utf8"));
    if (!Array.isArray(plan.steps) || !plan.steps.length) throw new Error("计划为空");
    const completed = plan.steps.filter((step: any) => step?.status === "completed").length;
    return { total: plan.steps.length as number, completed, all_completed: completed === plan.steps.length, error: null };
  } catch (error) {
    return { total: 0, completed: 0, all_completed: false, error: String(error) };
  }
}

/** Counts are best-effort summaries of Node TAP/spec and pytest output; raw output remains authoritative. */
export function summarizeTest(result: TestResult) {
  const output = (result.stdout + "\n" + result.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const nodeCount = (name: string) => {
    const matches = [...output.matchAll(new RegExp(`^(?:#|ℹ) ${name} (\\d+)\\s*$`, "gm"))];
    return matches.length ? Number(matches.at(-1)![1]) : null;
  };
  const pytestSummary = output.split("\n").filter(line => /^=+ .* in [\d.]+s.*=+$/.test(line)).at(-1);
  const pytestCount = (name: string) => {
    if (!pytestSummary) return null;
    const match = pytestSummary.match(new RegExp(`(?:^|[ ,=])(\\d+) ${name}(?=[ ,=]|$)`));
    return match ? Number(match[1]) : 0;
  };
  const passedNames: string[] = [], failedNames: string[] = [], failedSubtests: string[] = [];
  for (const line of output.split("\n")) {
    const py = line.match(/^(\S+::.*?)\s+(PASSED|FAILED|ERROR)(?:\s|$)/);
    const tap = line.match(/^(not ok|ok) \d+ - (.+?)(?: # .*)?$/);
    const spec = line.match(/^[✔✖] (.+?) \([\d.]+m?s\)$/);
    const subtest = line.match(/^SUBFAILED(\(.*\))\s+(\S+::.+)$/);
    const failure = line.match(/^(?:FAILED|ERROR) (\S+::.+?)(?: - |$)/);
    if (subtest) {
      // pytest can print the parent as PASSED even when its unittest subtests failed.
      failedNames.push(subtest[2]);
      failedSubtests.push(`${subtest[2]} ${subtest[1]}`);
    } else if (failure) failedNames.push(failure[1]);
    else if (py) (py[2] === "PASSED" ? passedNames : failedNames).push(py[1]);
    else if (tap && !/ # (?:SKIP|TODO)/i.test(line)) (tap[1] === "ok" ? passedNames : failedNames).push(tap[2]);
    else if (spec) (line.startsWith("✔") ? passedNames : failedNames).push(spec[1]);
  }
  return {
    status: result.time_out ? "timeout" : result.exit_code === 0 ? "passed" : result.exit_code === 1 ? "failed" : "error",
    exit_code: result.exit_code, time_out: result.time_out,
    counts: {
      passed: nodeCount("pass") ?? pytestCount("passed"),
      failed: nodeCount("fail") ?? pytestCount("failed"),
      skipped: nodeCount("skipped") ?? pytestCount("skipped"),
      errors: pytestCount("errors?"),
      subtests_passed: pytestCount("subtests passed"),
    },
    passed_test_names: [...new Set(passedNames)].filter(name => !failedNames.includes(name)),
    failed_test_names: [...new Set(failedNames)], failed_subtest_names: [...new Set(failedSubtests)],
  };
}

// verify: tests the harness runs itself (plan-and-execute step acceptance and final check).
export type TestPhase = "baseline" | "agent" | "verify" | "apply";
export type TestRun = ReturnType<typeof summarizeTest> & {
  phase: TestPhase; scope: "full" | "partial"; round: number | null; revision: number; started_at: string; duration_ms: number;
};

export class TestHistory {
  runs: TestRun[] = [];
  revision = 0;
  constructor(private taskDir: string) {}

  async record(phase: TestPhase, round: number | null, result: TestResult, startedAt: string, start: number) {
    const run = { phase, scope: result.scope ?? "full", round, revision: this.revision, started_at: startedAt,
      duration_ms: Math.round(performance.now() - start), ...summarizeTest(result) };
    this.runs.push(run);
    await fs.appendFile(path.join(this.taskDir, "tests.jsonl"), JSON.stringify({ ...run, stdout: result.stdout, stderr: result.stderr }) + "\n");
  }

  summary() {
    const baseline = this.runs.find(run => run.phase === "baseline") ?? null;
    // Partial runs stay in `runs` but never stand in for the full-suite comparison.
    const latest = this.runs.filter(run => run.phase !== "baseline" && run.scope === "full").at(-1) ?? null;
    const current = latest?.revision === this.revision;
    return {
      baseline, latest, latest_is_current: current,
      comparison: !baseline || !latest || !current ? "unavailable"
        : `${baseline.status}_to_${latest.status}`,
      // Only compare explicitly observed test identities, never infer missing tests passed.
      fixed_test_names: current && baseline && latest
        ? baseline.failed_test_names.filter(name => latest.passed_test_names.includes(name)) : [],
      regressed_test_names: current && baseline && latest
        ? latest.failed_test_names.filter(name => baseline.passed_test_names.includes(name)) : [],
      runs: this.runs,
    };
  }
}

async function callStatistics(taskDir: string, kind: "round" | "summary") {
  const dir = path.join(taskDir, "model");
  const pattern = new RegExp(`^${kind}-\\d+$`);
  const rounds = (await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return []; throw e;
  })).filter(name => pattern.test(name)).sort();
  const tokens: Record<"prompt_tokens" | "completion_tokens" | "total_tokens", number | null> = {
    prompt_tokens: null, completion_tokens: null, total_tokens: null,
  };
  const reported = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const models = new Set<string>();
  let apiCalls = 0, durationMs = 0, completed = 0;
  for (const round of rounds) {
    const location = path.join(dir, round);
    const meta = JSON.parse(await fs.readFile(path.join(location, "meta.json"), "utf8"));
    durationMs += meta.duration_ms ?? 0;
    if (meta.status === "completed") completed++;
    if (meta.mode !== "api") continue; // Replays consume no API tokens in this run.
    apiCalls++;
    const request = JSON.parse(await fs.readFile(path.join(location, "request.json"), "utf8"));
    if (typeof request.model === "string") models.add(request.model);
    if (meta.status !== "completed") continue;
    const response = JSON.parse(await fs.readFile(path.join(location, "response.json"), "utf8"));
    for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) {
      const value = response.usage?.[key];
      if (Number.isInteger(value) && value >= 0) {
        tokens[key] = (tokens[key] ?? 0) + value;
        reported[key]++;
      }
    }
  }
  return { rounds: rounds.length, completed_rounds: completed, api_calls: apiCalls,
    models: [...models], duration_ms: durationMs,
    usage: { ...tokens, reported_calls: reported,
      complete: apiCalls > 0 && Object.values(reported).every(count => count === apiCalls) } };
}

/** Agent turns; model-written context summaries are reported separately under `summary`. */
export async function modelStatistics(taskDir: string) {
  const summary = await callStatistics(taskDir, "summary");
  return { ...await callStatistics(taskDir, "round"),
    summary: { api_calls: summary.api_calls, duration_ms: summary.duration_ms, usage: summary.usage } };
}

export function changeSummary(changes: FileChange[]) {
  const files = changes.map(change => {
    const lines = change.binary ? [] : diffLines(change.before?.toString("utf8") ?? "", change.after?.toString("utf8") ?? "");
    return { path: change.path, created: change.before === null, deleted: change.after === null, binary: change.binary,
      is_test: isTestFile(change.path) || isTestConfig(change.path),
      added_lines: lines.filter(line => line.added).reduce((sum, line) => sum + (line.count ?? 0), 0),
      deleted_lines: lines.filter(line => line.removed).reduce((sum, line) => sum + (line.count ?? 0), 0) };
  });
  return { files, file_count: files.length, tests_modified: files.some(file => file.is_test),
    added_lines: files.reduce((sum, file) => sum + file.added_lines, 0),
    deleted_lines: files.reduce((sum, file) => sum + file.deleted_lines, 0) };
}

export function renderReport(report: {
  task_id: string; status: string; applied: boolean;
  task: { text: string; source: string; mode: string; initial_fingerprint: Awaited<ReturnType<typeof fingerprint>> };
  timing: { started_at: string; ended_at: string; duration_ms: number };
  termination: { reason: string; error: string | null; verified: boolean; plan: Awaited<ReturnType<typeof readPlanProgress>> };
  statistics: { model: Awaited<ReturnType<typeof modelStatistics>>; tool_calls: number; successful_writes: number; test_runs: number;
    context?: { max_estimated_tokens: number; rounds_with_dropping: number; max_dropped_groups: number; summarized_rounds: number; llm_summary_calls: number; llm_summary_errors: number };
    model_requests?: { retries: number; context_overflow_retries: number };
    loop?: { guard: boolean; warnings: number; detections: string[] } };
  tests: ReturnType<TestHistory["summary"]>; changes: ReturnType<typeof changeSummary>;
}) {
  const testText = (test: TestRun | null) => !test ? "未执行" : `${test.status}；通过计数 ${test.counts.passed ?? "未知"}，失败计数 ${test.counts.failed ?? "未知"}，子测试通过 ${test.counts.subtests_passed ?? "未知"}${test.failed_subtest_names.length ? `；已识别失败子测试 ${test.failed_subtest_names.length} 个` : ""}`;
  const model = report.statistics.model;
  return [
    `任务：${report.task.text}`, `任务 ID：${report.task_id}`, `源项目：${report.task.source}`,
    `初始文件 SHA-256：${report.task.initial_fingerprint.value}`,
    `模式：${report.task.mode}；模型：${model.models.join(", ") || "不适用（未调用模型 API）"}`,
    `开始：${report.timing.started_at}；结束：${report.timing.ended_at}`,
    `总耗时：${(report.timing.duration_ms / 1000).toFixed(2)} 秒`, "",
    `结果：${report.status}；结束原因：${report.termination.reason}`,
    `修复前：${testText(report.tests.baseline)}`,
    `修复后最近一次测试：${testText(report.tests.latest)}${report.tests.latest && !report.tests.latest_is_current ? "（已过期，之后发生过写入）" : ""}`,
    `对比：${report.tests.comparison}`,
    `已观察到修复的测试：${report.tests.fixed_test_names.join(", ") || "无/信息不足"}`,
    `已观察到回归的测试：${report.tests.regressed_test_names.join(", ") || "无/信息不足"}`,
    `计划：${report.termination.plan.completed}/${report.termination.plan.total} 完成`,
    `最终修改后验证：${report.termination.verified ? "通过" : "未通过或未执行"}`, "",
    `模型轮次：${model.rounds}；真实 API 调用：${model.api_calls}；工具调用：${report.statistics.tool_calls}`,
    `成功写入：${report.statistics.successful_writes}；测试执行：${report.statistics.test_runs}（含基线和回写验证）`,
    ...(report.statistics.model_requests?.retries || report.statistics.model_requests?.context_overflow_retries
      ? [`模型请求：重试 ${report.statistics.model_requests.retries} 次；服务端上下文超限后缩小重发 ${report.statistics.model_requests.context_overflow_retries} 次`] : []),
    ...(report.statistics.loop?.detections.length ? [`重复检测：${report.statistics.loop.detections.join("；")}`] : []),
    ...(report.statistics.context?.max_estimated_tokens ? [`上下文：单轮最大估算 ${report.statistics.context.max_estimated_tokens} tokens；裁剪 ${report.statistics.context.rounds_with_dropping} 轮（最多省略 ${report.statistics.context.max_dropped_groups} 组）；插入摘要 ${report.statistics.context.summarized_rounds} 轮；模型摘要调用 ${report.statistics.context.llm_summary_calls} 次，失败 ${report.statistics.context.llm_summary_errors} 次`] : []),
    `Token：输入 ${model.usage.prompt_tokens ?? "未知/不适用"} / 输出 ${model.usage.completion_tokens ?? "未知/不适用"} / 总计 ${model.usage.total_tokens ?? "未知/不适用"}；用量完整：${model.usage.complete ? "是" : "否/不适用"}`,
    `改动：${report.changes.file_count} 个文件，+${report.changes.added_lines} / -${report.changes.deleted_lines} 行`,
    ...report.changes.files.map(file => `  ${file.path}：+${file.added_lines} / -${file.deleted_lines}`),
    `测试文件修改：${report.changes.tests_modified ? "是" : "否"}；回写源项目：${report.applied ? "是" : "否"}`,
    ...(report.termination.error ? [`错误：${report.termination.error}`] : []), "",
    "测试计数来自运行器摘要；pytest 的失败计数可能包含子测试，不能与通过计数相加作为主测试总数。",
    "用例名称为日志解析结果；未知值不表示零。原始测试输出见 tests.jsonl。", "",
  ].join("\n");
}
