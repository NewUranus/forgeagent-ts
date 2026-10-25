import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyEdit, numberLines, executeTool, runTests } from "../src/tools.ts";
import { runAgent } from "../src/agent.ts";
import type { Message } from "../src/types.ts";

async function project(t: any, files: Record<string, string>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-tools-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return { base, root };
}

test("applyEdit replaces exactly one occurrence and explains ambiguous or missing matches", () => {
  assert.deepEqual(applyEdit("a\nb\nc\n", "b", "B"), { content: "a\nB\nc\n", line: 2 });
  assert.throws(() => applyEdit("abc", "x", "y"), /没有找到 old_str.*行号前缀/);
  assert.throws(() => applyEdit("x = 1; x = 1;", "x = 1;", "x = 2;"), /出现了 2 次/);
  // Overlapping matches count too, so "aa" in "aaa" is ambiguous.
  assert.throws(() => applyEdit("aaa", "aa", "b"), /出现了 2 次/);
  assert.throws(() => applyEdit("abc", "", "x"), /不能为空/);
  assert.throws(() => applyEdit("abc", "b", "b"), /相同/);
  // "$&" stays literal: String.replace would have inserted the match.
  assert.equal(applyEdit("price", "price", "`$&${x}$$`").content, "`$&${x}$$`");
  // LF text from the model keeps the file's CRLF style.
  assert.equal(applyEdit("a\r\nb\r\nc\r\n", "a\nb", "x\ny").content, "x\r\ny\r\nc\r\n");
});

test("numberLines numbers from 1, honours ranges and caps long output", () => {
  assert.equal(numberLines(""), "（空文件）");
  assert.equal(numberLines("a\r\nb\n"), "1\ta\n2\tb");
  assert.equal(numberLines("a\nb\nc\n", 2, 9), "2\tb\n3\tc");
  assert.throws(() => numberLines("a\n", 3), /文件共 1 行/);
  assert.throws(() => numberLines("a\nb\n", 2, 1), /不能小于/);
  const many = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
  const first = numberLines(many);
  assert.match(first, /^  1\tline 1$/m);
  assert.match(first, /^400\tline 400$/m);
  assert.doesNotMatch(first, /line 401/);
  assert.match(first, /文件共 1000 行，已显示第 1–400 行；用 start_line=401 继续读取/);
  assert.match(numberLines("x".repeat(5000)), /本行共 5000 字符，已截断/);
});

test("edit_file and write_file protect tests, report syntax problems and need existing files for edits", async t => {
  const { root } = await project(t, { "a.ts": "export const a = 1;\n", "a.test.ts": "", "b.py": "x = 1\n" });
  assert.match(await executeTool(root, "edit_file", { relative_path: "a.ts", old_str: "1", new_str: "2" }) as string, /第 1 行.*语法检查通过/);
  assert.equal(await fs.readFile(path.join(root, "a.ts"), "utf8"), "export const a = 2;\n");
  assert.match(await executeTool(root, "edit_file", { relative_path: "a.ts", old_str: "= 2;", new_str: "= (;" }) as string, /语法检查发现 \d+ 个问题/);
  await assert.rejects(executeTool(root, "edit_file", { relative_path: "a.test.ts", old_str: "x", new_str: "y" }), /测试文件/);
  await assert.rejects(executeTool(root, "edit_file", { relative_path: "new.ts", old_str: "x", new_str: "y" }), /不存在.*write_file/);
  await assert.rejects(executeTool(root, "read_file", { relative_path: "a.ts", start_line: 0 }), /start_line/);
  const py = await executeTool(root, "write_file", { relative_path: "b.py", content: "def f(:\n" }) as string;
  // Python may be missing on the machine; then the check is skipped silently.
  if (py.includes("语法检查")) assert.match(py, /语法检查发现 1 个问题：\n第 1 行/);
  assert.deepEqual((await fs.readdir(root)).sort(), ["a.test.ts", "a.ts", "b.py"], "语法检查不能留下 __pycache__");
});

test("search_code supports regex, glob and context; find_files matches names in any directory", async t => {
  const { root } = await project(t, { "src/a.ts": "one\nconst value = 42;\nthree\n", "src/b.js": "value\n", "notes.md": "value\n", "bin.dat": "value\0" });
  const plain = await executeTool(root, "search_code", { keyword: "value" }) as any;
  assert.deepEqual(plain.matches.map((m: any) => m.path), ["notes.md", "src/a.ts", "src/b.js"], "跳过二进制文件");
  const regex = await executeTool(root, "search_code", { keyword: "value\\s*=\\s*\\d+", regex: true, glob: "src/**/*.ts", context_lines: 1 }) as any;
  assert.deepEqual(regex, { matches: [{ path: "src/a.ts", line: 2, text: "const value = 42;", before: ["one"], after: ["three"] }], total: 1, truncated: false });
  await assert.rejects(executeTool(root, "search_code", { keyword: "(", regex: true }), /正则无效/);
  await assert.rejects(executeTool(root, "search_code", { keyword: "x", context_lines: 9 }), /context_lines/);
  assert.deepEqual((await executeTool(root, "find_files", { pattern: "*.ts" }) as any).files, ["src/a.ts"]);
  assert.deepEqual((await executeTool(root, "find_files", { pattern: "src/*" }) as any).files, ["src/a.ts", "src/b.js"]);
});

test("run_tests can target one file or name, marked partial, and rejects non-test or outside targets", async t => {
  const pass = 'import { test } from "node:test"; test("pass one", () => {});';
  const fail = 'import { test } from "node:test"; test("fail one", () => { throw new Error("x"); });';
  const { root } = await project(t, { "package.json": '{"type":"module"}', "a.test.js": pass, "b.test.js": fail, "src.js": "" });
  assert.equal((await runTests(root)).scope, "full");
  const one = await runTests(root, undefined, { target: "a.test.js" });
  assert.equal(one.scope, "partial");
  assert.equal(one.exit_code, 0);
  assert.equal((await runTests(root, undefined, { namePattern: "pass" })).exit_code, 0);
  await assert.rejects(runTests(root, undefined, { target: "src.js" }), /不是测试文件/);
  await assert.rejects(runTests(root, undefined, { target: "../x.test.js" }), /超出/);
  await assert.rejects(runTests(root, undefined, { target: "a.test.js::x" }), /name_pattern/);
});

test("a target that is the project's only test file counts as a full run", async t => {
  const { root } = await project(t, { "package.json": '{"type":"module"}', "a.test.js": 'import { test } from "node:test"; test("pass one", () => {});' });
  assert.equal((await runTests(root, undefined, { target: "a.test.js" })).scope, "full");
  assert.equal((await runTests(root, undefined, { target: "./a.test.js" })).scope, "full");
  assert.equal((await runTests(root, undefined, { target: "a.test.js", namePattern: "pass" })).scope, "partial");
});

test("a passing partial run never verifies, and edit_file invalidates earlier verification", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-partial-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(source, "answer.js"), "export const answer = 0;\n");
  await fs.writeFile(path.join(source, "answer.test.js"),
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { answer } from "./answer.js"; test("answer is 42", () => assert.equal(answer, 42));');
  await fs.writeFile(path.join(source, "other.test.js"), 'import { test } from "node:test"; test("other", () => {});');
  const call = (id: string, name: string, args = {}): Message => ({ role: "assistant", content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const plan = call("plan", "update_plan", { steps: [{ id: "fix", description: "修复并验证", status: "completed" }] });
  const done: Message = { role: "assistant", content: "完成" };

  // Only the unrelated test file passes: that must not count as verification.
  let replies = [call("p", "run_tests", { target: "other.test.js" }), plan, done];
  let seen: Message[] = [];
  const partial = await runAgent({ base, source, reply: async (messages) => { seen = messages; return replies.shift() ?? done; }, maxRounds: 4 });
  assert.equal(partial.status, "limit_reached");
  // The exit check must say the run was partial, not that the tests failed: they passed.
  const feedback = seen.at(-1)!.content!;
  assert.match(feedback, /只运行了部分测试/);
  assert.doesNotMatch(feedback, /没有通过/);
  assert.equal(partial.termination.verified, false);
  assert.ok(partial.tests.runs.some((run: any) => run.scope === "partial" && run.status === "passed"));
  assert.equal(partial.tests.latest, null, "前后对比只使用全量测试");

  // Verified by a full run, then an edit_file afterwards must invalidate it.
  replies = [
    call("w", "edit_file", { relative_path: "answer.js", old_str: "= 0", new_str: "= 42" }),
    call("t", "run_tests"),
    call("e", "edit_file", { relative_path: "answer.js", old_str: "42;", new_str: "42; " }),
    plan, done,
  ];
  const stale = await runAgent({ base, source, reply: async () => replies.shift() ?? done, maxRounds: 5 });
  assert.equal(stale.status, "limit_reached");
  assert.equal(stale.termination.verified, false);
  assert.equal(stale.statistics.successful_writes, 2);
  assert.equal(stale.tests.latest_is_current, false);
});

// Regression from the 2026-10-25 eval baseline: the model checked its fix with the sole test file as
// target, the run counted as partial, and the misleading exit check cost it the rest of its rounds.
test("fix verified by targeting the only test file passes the exit check", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-target-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(source, "answer.js"), "export const answer = 0;\n");
  await fs.writeFile(path.join(source, "answer.test.js"),
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { answer } from "./answer.js"; test("answer is 42", () => assert.equal(answer, 42));');
  const call = (id: string, name: string, args = {}): Message => ({ role: "assistant", content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const replies = [
    call("w", "edit_file", { relative_path: "answer.js", old_str: "= 0", new_str: "= 42" }),
    call("t", "run_tests", { target: "answer.test.js" }),
    call("p", "update_plan", { steps: [{ id: "fix", description: "修复并验证", status: "completed" }] }),
  ];
  const report = await runAgent({ base, source, reply: async () => replies.shift() ?? { role: "assistant", content: "完成" }, maxRounds: 4 });
  assert.equal(report.status, "passed");
  assert.equal(report.statistics.model.rounds, 4);
  assert.equal(report.tests.latest?.scope, "full");
});
