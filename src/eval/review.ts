import { promises as fs } from "node:fs";
import path from "node:path";
import { diffLines } from "diff";
import { ChatSession, type ChatOptions, type ChatTurn, type Finding } from "../chat.js";
import { listFiles, projectPath } from "../workspace.js";
import { isTestFile } from "../tools.js";
import { modelStatistics } from "../report.js";
import { isAccountError } from "../model/retry.js";
import { loadTasks } from "./run.js";

/** Lines removed or replaced by the reference fix; pure insertions point to the preceding line. */
export function changedLines(buggy: string, fixed: string): number[] {
  const changes = diffLines(buggy, fixed), lines = new Set<number>();
  let line = 1;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change.added && !change.removed) { line += change.count; continue; }
    const start = line;
    let removed = 0;
    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      if (changes[i].removed) removed += changes[i].count;
      i++;
    }
    i--;
    if (removed) for (let n = start; n < start + removed; n++) lines.add(n);
    else lines.add(Math.max(1, start - 1));
    line += removed;
  }
  return [...lines].sort((a, b) => a - b);
}

export function hitsBug(findings: Finding[], file: string, lines: number[], tolerance = 1): boolean {
  return findings.some((f) => f.file === file && lines.some((line) => line >= f.line - tolerance && line <= (f.end_line ?? f.line) + tolerance));
}

export interface ReviewOptions {
  tasksDir: string;
  outDir: string;
  only?: string[];
  repeat?: number;
  label?: string;
  chat?: Omit<ChatOptions, "source">;
  quiet?: boolean;
  log?: (line: string) => void;
}
interface ReviewAttempt {
  task: string;
  attempt: number;
  hit: boolean;
  findings: Finding[];
  findings_count: number;
  unmatched_findings: number;
  status: ChatTurn["status"] | "error";
  rounds: number;
  tool_calls: number;
  total_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number;
  task_dir: string | null;
  error: string | null;
  account_error: boolean;
}

export async function runReviewEval(options: ReviewOptions) {
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat 必须是正整数");
  const tasks = await loadTasks(options.tasksDir, options.only);
  const startedAt = new Date(), attempts: ReviewAttempt[] = [];
  const log = options.log ?? ((line: string) => console.log(line));
  let stoppedEarly: { after: number; skipped: number; error: string | null } | null = null;
  run: for (const task of tasks) {
    const solution = path.join(options.tasksDir, task.name, "solution");
    const bugs: { name: string; content: string; lines: number[] }[] = [];
    for (const file of await listFiles(solution)) {
      if (isTestFile(file)) continue;
      const content = await fs.readFile(await projectPath(task.project, file), "utf8");
      const fixed = await fs.readFile(await projectPath(solution, file), "utf8");
      const lines = changedLines(content, fixed);
      if (lines.length) bugs.push({ name: path.basename(file), content, lines });
    }
    if (!bugs.length) throw new Error(`评测任务 ${task.name} 没有含 bug 的文件`);
    for (let attempt = 1; attempt <= repeat; attempt++) {
      const start = performance.now();
      let session: ChatSession | undefined, turn: ChatTurn | undefined, error: unknown;
      try {
        session = await ChatSession.create({ ...options.chat, source: undefined, stream: false, quiet: options.quiet ?? true });
        turn = await session.ask("这段代码有 bug 吗？找出问题并说明。", bugs.map(({ name, content }) => ({ name, content })));
      } catch (caught) { error = caught; }
      const findings = turn?.findings ?? [];
      const matches = (items: Finding[]) => bugs.some((bug, i) => hitsBug(items, turn!.attachments[i], bug.lines, 1));
      const model = session ? await modelStatistics(session.taskDir) : null;
      const result: ReviewAttempt = {
        task: task.name, attempt, hit: !!turn && matches(findings), findings, findings_count: findings.length,
        unmatched_findings: findings.filter((f) => !matches([f])).length,
        status: turn?.status ?? "error", rounds: turn?.rounds ?? model?.rounds ?? 0, tool_calls: turn?.tool_calls ?? 0,
        total_tokens: model?.usage.total_tokens ?? null, prompt_tokens: model?.usage.prompt_tokens ?? null, completion_tokens: model?.usage.completion_tokens ?? null,
        duration_ms: Math.round(performance.now() - start), task_dir: session?.taskDir ?? null,
        error: error === undefined ? null : String(error), account_error: isAccountError(error),
      };
      attempts.push(result);
      log(`[${attempts.length}/${tasks.length * repeat}] ${task.name} #${attempt}：${result.hit ? "命中" : "未命中"}，${findings.length} 条问题，${result.unmatched_findings} 条未命中 bug，${result.total_tokens ?? "—"} tokens，${(result.duration_ms / 1000).toFixed(1)} 秒`);
      if (result.account_error) {
        stoppedEarly = { after: attempts.length, skipped: tasks.length * repeat - attempts.length, error: result.error };
        log(`账户或配置错误，停止评测，其余 ${stoppedEarly.skipped} 次不再运行：${result.error}`);
        break run;
      }
    }
  }
  const hits = attempts.filter((a) => a.hit).length;
  const result = {
    schema_version: 1, label: options.label ?? null, started_at: startedAt.toISOString(), ended_at: new Date().toISOString(), repeat,
    stopped_early: stoppedEarly,
    totals: { tasks: tasks.length, attempts: attempts.length, hits, hit_rate: attempts.length ? hits / attempts.length : 0 },
    tasks: tasks.map((task) => {
      const runs = attempts.filter((a) => a.task === task.name);
      return { task: task.name, attempts: runs.length, hits: runs.filter((a) => a.hit).length };
    }),
    attempts,
  };
  await fs.mkdir(options.outDir, { recursive: true });
  const stem = `review-${startedAt.toISOString().replace(/[:.]/g, "-")}${options.label ? `-${options.label.replace(/[^\w.-]+/g, "_")}` : ""}`;
  const json = path.join(options.outDir, `${stem}.json`), markdown = path.join(options.outDir, `${stem}.md`);
  await fs.writeFile(json, JSON.stringify(result, null, 2) + "\n");
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  await fs.writeFile(markdown, [
    `# 对话式代码审查评测${options.label ? `：${options.label}` : ""}`, "",
    `时间：${result.started_at} → ${result.ended_at}`, "",
    `命中 ${hits}/${attempts.length}，命中率 ${(result.totals.hit_rate * 100).toFixed(1)}%。每个任务计划运行 ${repeat} 次。`,
    ...(stoppedEarly ? ["", `账户或配置错误，提前停止：${cell(stoppedEarly.error ?? "")}；跳过 ${stoppedEarly.skipped} 次。`] : []), "",
    "| 任务 | 次数 | 命中 | 问题数 | 未命中 bug 的问题数 | 输入/输出/总 token | 耗时 | 状态 |",
    "|---|---|---|---|---|---|---|---|",
    ...attempts.map((a) => `| ${cell(a.task)} | ${a.attempt} | ${a.hit ? "是" : "否"} | ${a.findings_count} | ${a.unmatched_findings} | ${a.prompt_tokens ?? "—"}/${a.completion_tokens ?? "—"}/${a.total_tokens ?? "—"} | ${(a.duration_ms / 1000).toFixed(1)}s | ${cell(a.error ?? a.status)} |`),
    "", "命中 = 问题的行号区间与参考修复改动行的距离不超过 1 行。未命中 bug 的问题可能是误报，也可能是真实的次要问题；只按位置计数，不代表问题语义已被验证。没有给模型测试文件或任务说明。完整问题列表和运行目录见 JSON。", "",
  ].join("\n"));
  return { result, files: { json, markdown } };
}
