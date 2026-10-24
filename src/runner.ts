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
export async function runRepairDemo(base = ROOT, source = path.join(ROOT, "playground")) {
  const { projectDir: root, taskDir } = await createWorkspace(source, base);
  const file = path.join(root, "calculator.ts");
  const original = await fs.readFile(file, "utf8");
  // Inject a defect only into this new demonstration copy.
  await fs.writeFile(
    file,
    "export function average(numbers: (number|null)[]): number { return numbers.reduce<number>((s,n)=>s+(n??0),0)/numbers.length; }",
  );
  const initial = await runTests(root);
  let status = classify(initial);
  const history: unknown[] = [{ attempt: 0, status, ...initial }];
  if (status !== "passed") {
    const backup = await fs.readFile(file, "utf8");
    await fs.writeFile(file + ".bak", backup);
    const candidates = [
      "export function average( {",
      "export function average(numbers: (number|null)[]) { return 0; }",
      original,
    ];
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
