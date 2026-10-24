import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ROOT } from "./config.js";
import { createWorkspace } from "./workspace.js";
import { runTests } from "./tools.js";
import type { TaskStatus, TestResult } from "./types.js";
const classify = (r: TestResult): TaskStatus =>
  r.time_out
    ? "timeout"
    : r.exit_code === 0
      ? "passed"
      : r.exit_code === 1
        ? "failed"
        : "error";
// stats_helpers.ts with a chosen body for count(); total() matches the playground.
const helpers = (countBody: string) =>
  `export function total(numbers: (number | null)[]): number {
  return numbers.reduce<number>((sum, n) => sum + (n ?? 0), 0);
}
export function count(numbers: (number | null)[]): number {
  ${countBody}
}
`;
// The playground's real defect: count() includes one extra element.
export const DEFECT = helpers("return numbers.filter(n => n !== null).length + 1;");
export const CANDIDATES = [
  // Missing closing brace: rejected by the syntax check before any test runs.
  helpers("return numbers.filter(n => n !== null).length;").replace(/\n}\n$/, "\n"),
  // Counts nulls too, so averages with null inputs stay wrong.
  helpers("return numbers.length;"),
  helpers("return numbers.filter(n => n !== null).length;"),
];

/**
 * Deterministic repair loop without a model: set count() to the known defect (whatever state the
 * source is in), then try a syntax error, a wrong fix and the right fix, testing after each.
 */
export async function runRepairDemo(base = ROOT, source = path.join(ROOT, "playground")) {
  const { projectDir: root, taskDir } = await createWorkspace(source, base);
  const file = path.join(root, "stats_helpers.ts");
  // Inject the defect only into this new demonstration copy.
  await fs.writeFile(file, DEFECT);
  const initial = await runTests(root);
  let status = classify(initial);
  const history: unknown[] = [{ attempt: 0, status, ...initial }];
  if (status !== "passed") {
    const backup = await fs.readFile(file, "utf8");
    await fs.writeFile(file + ".bak", backup);
    const candidates = CANDIDATES;
    for (const [index, code] of candidates.entries()) {
      const diagnostics =
        ts.transpileModule(code, {
          reportDiagnostics: true,
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
          },
        }).diagnostics ?? [];
      if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) {
        status = "error";
        history.push({ attempt: index + 1, status, error: "语法错误" });
        continue;
      }
      await fs.writeFile(file, code);
      const result = await runTests(root);
      status = classify(result);
      history.push({ attempt: index + 1, status, ...result });
      if (status === "passed") break;
    }
    if (status !== "passed") await fs.writeFile(file, backup);
  }
  const report = { final_status: status, task_dir: taskDir, workspace: root, history };
  await fs.writeFile(path.join(taskDir, "report.json"), JSON.stringify(report, null, 2));
  await fs.mkdir(path.join(base, "runs"), { recursive: true });
  await fs.writeFile(
    path.join(base, "runs", "latest.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `修复演示：${status}，报告：${path.join(base, "runs/latest.json")}`,
  );
  return report;
}
