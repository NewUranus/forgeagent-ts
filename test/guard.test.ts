import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { findTestTampering, isTestConfig, testSettings } from "../src/guard.ts";
import { executeTool } from "../src/tools.ts";
import { diffWorkspace, snapshotFiles } from "../src/workspace.ts";
import { runAgent } from "../src/agent.ts";
import type { Message } from "../src/types.ts";

const call = (id: string, name: string, args = {}): Message => ({ role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const plan = call("plan", "update_plan", { steps: [{ id: "fix", description: "修复并验证", status: "completed" }] });
const done: Message = { role: "assistant", content: "完成" };

async function fixture(t: any) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-guard-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" }, dependencies: {} }, null, 2));
  await fs.writeFile(path.join(source, "answer.js"), "export const answer = 0;\n");
  await fs.writeFile(path.join(source, "answer.test.js"),
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { answer } from "./answer.js"; test("answer is 42", () => assert.equal(answer, 42));');
  return { base, source };
}
const projectOf = async (base: string) => {
  const [id] = await fs.readdir(path.join(base, "workspace"));
  return path.join(base, "workspace", id, "project");
};

test("test configs are recognised; shared files expose only their test settings", () => {
  for (const name of ["conftest.py", "pkg/conftest.py", "pytest.ini", "jest.config.ts", "vitest.config.mjs", ".mocharc.json", "karma.conf.js"])
    assert.ok(isTestConfig(name), name);
  for (const name of ["config.py", "src/jest.ts", "pytest_plugin.py"]) assert.ok(!isTestConfig(name), name);
  const pkg = (scripts: object, extra = {}) => JSON.stringify({ name: "x", scripts, ...extra });
  assert.equal(testSettings("package.json", pkg({ test: "jest" }, { dependencies: { a: "1" } })), testSettings("package.json", pkg({ test: "jest", build: "tsc" })));
  assert.notEqual(testSettings("package.json", pkg({ test: "jest" })), testSettings("package.json", pkg({ test: "true" })));
  const toml = (pytest: string) => `[project]\nname = "x"\n[tool.pytest.ini_options]\naddopts = "${pytest}"\n[tool.black]\nline-length = 88\n`;
  assert.equal(testSettings("pyproject.toml", toml("-q")), '[tool.pytest.ini_options]\naddopts = "-q"');
  assert.notEqual(testSettings("pyproject.toml", toml("-q")), testSettings("pyproject.toml", toml("-k nothing")));
  assert.equal(testSettings("src/app.ts", "x"), null);
});

test("findTestTampering reports added, changed and deleted tests and changed test settings only", () => {
  const b = (text: string) => Buffer.from(text);
  const before = new Map([["a.test.js", b("t")], ["old.test.js", b("t")], ["app.js", b("1")], ["package.json", b('{"scripts":{"test":"node --test"}}')]]);
  const after = new Map([["a.test.js", b("t2")], ["new.test.js", b("t")], ["app.js", b("2")], ["conftest.py", b("")], ["package.json", b('{"scripts":{"test":"true"}}')]]);
  assert.deepEqual(findTestTampering(before, after), [
    "修改了测试文件或测试配置 a.test.js",
    "新增了测试文件或测试配置 conftest.py",
    "新增了测试文件或测试配置 new.test.js",
    "删除了测试文件或测试配置 old.test.js",
    "修改了 package.json 中的测试配置",
  ]);
  assert.deepEqual(findTestTampering(before, before), []);
});

test("tools refuse test configs and test-setting edits but allow other edits to shared files", async t => {
  const { source: root } = await fixture(t);
  await assert.rejects(executeTool(root, "write_file", { relative_path: "conftest.py", content: "" }), /测试文件或测试配置/);
  await assert.rejects(executeTool(root, "write_file", { relative_path: "sub/pytest.ini", content: "" }), /测试文件或测试配置/);
  await assert.rejects(executeTool(root, "edit_file", { relative_path: "package.json", old_str: '"node --test"', new_str: '"true"' }), /package\.json 中的测试配置/);
  await executeTool(root, "edit_file", { relative_path: "package.json", old_str: '"dependencies": {}', new_str: '"dependencies": { "x": "1" }' });
  await assert.rejects(executeTool(root, "write_file", { relative_path: "package.json", content: "{}" }), /测试配置/);
});

test("exit check blocks completion when tests change outside the tools", async t => {
  const { base, source } = await fixture(t);
  let first = true;
  const replies = [call("w", "edit_file", { relative_path: "answer.js", old_str: "= 0", new_str: "= 42" }), call("t", "run_tests"), plan, done];
  const report = await runAgent({ base, source, maxRounds: 4, reply: async () => {
    if (first) {
      first = false;
      // Simulate a change that bypasses tool-level protection, e.g. a future shell command.
      await fs.appendFile(path.join(await projectOf(base), "answer.test.js"), "\n// weakened\n");
    }
    return replies.shift() ?? done;
  } });
  assert.equal(report.status, "limit_reached");
  assert.equal(report.termination.verified, true, "测试本身通过，拦住它的是出口校验");
  assert.deepEqual(report.termination.test_tampering, ["修改了测试文件或测试配置 answer.test.js"]);
  assert.equal(report.changes.tests_modified, true);
});

test("diff and apply cover every file type, including binary files and new files", async t => {
  const { base, source } = await fixture(t);
  await fs.writeFile(path.join(source, "logo.png"), Buffer.from([0x89, 0x50, 0, 1]));
  let first = true;
  const replies = [
    call("w", "edit_file", { relative_path: "answer.js", old_str: "= 0", new_str: "= 42" }),
    call("y", "write_file", { relative_path: "config/app.yaml", content: "debug: true\n" }),
    call("t", "run_tests"), plan, done,
  ];
  const report = await runAgent({ base, source, apply: true, maxRounds: 5, reply: async () => {
    if (first) {
      first = false;
      await fs.writeFile(path.join(await projectOf(base), "logo.png"), Buffer.from([0x89, 0x50, 0, 2]));
    }
    return replies.shift() ?? done;
  } });
  assert.equal(report.status, "passed");
  assert.deepEqual(report.changed_files, ["answer.js", "config/app.yaml", "logo.png"]);
  const logo = report.changes.files.find((file: any) => file.path === "logo.png");
  assert.equal(logo.binary, true);
  assert.equal(report.changes.files.find((file: any) => file.path === "config/app.yaml").created, true);
  const patch = await fs.readFile(path.join(report.task_dir, "changes.patch"), "utf8");
  assert.match(patch, /^Binary files a\/logo\.png and b\/logo\.png differ$/m);
  assert.match(patch, /^\+debug: true$/m);
  assert.equal(report.applied, true);
  assert.equal(await fs.readFile(path.join(source, "config/app.yaml"), "utf8"), "debug: true\n");
  assert.deepEqual([...await fs.readFile(path.join(source, "logo.png"))], [0x89, 0x50, 0, 2]);
});

test("diffWorkspace tells an empty file from a missing one", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-diff-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, "a"));
  await fs.mkdir(path.join(base, "b"));
  await fs.writeFile(path.join(base, "b", "empty.txt"), "");
  const { changes } = await diffWorkspace(path.join(base, "a"), path.join(base, "b"), await snapshotFiles(path.join(base, "a")));
  assert.deepEqual(changes.map(c => [c.path, c.before, c.after?.length]), [["empty.txt", null, 0]]);
});
