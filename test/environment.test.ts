import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { runAgent } from "../src/agent.ts";
import { createWorkspace, listFiles } from "../src/workspace.ts";
import { dockerRunArgs, runTests } from "../src/tools.ts";
import { MCPClient } from "../src/mcp/client.ts";
import { grade, loadSweTask, parseInstanceInfo, sweTestConfig } from "../src/bench/swe-pro.ts";
import type { Message } from "../src/types.ts";

const call = (id: string, name: string, args = {}): Message => ({ role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const plan = call("plan", "update_plan", { steps: [{ id: "fix", description: "修复并验证", status: "completed" }] });
const done: Message = { role: "assistant", content: "完成" };
const testFile = 'import { test } from "node:test"; import assert from "node:assert/strict"; import { answer } from "./answer.js"; test("answer is 42", () => assert.equal(answer, 42));';

async function temp(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-env-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function project(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(dir, "answer.js"), "export const answer = 0;\n");
  await fs.writeFile(path.join(dir, "answer.test.js"), testFile);
  return dir;
}
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
async function repo(dir: string) {
  await project(dir);
  await fs.writeFile(path.join(dir, ".gitignore"), "build/\n");
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("git mode works on a branch, respects .gitignore and commits there without touching the checkout", async t => {
  const base = await temp(t);
  const source = await repo(path.join(base, "source"));
  const replies = [
    call("e", "edit_file", { relative_path: "answer.js", old_str: "= 0", new_str: "= 42" }),
    call("b", "write_file", { relative_path: "build/out.txt", content: "artifact" }),
    call("t", "run_tests"), plan, done,
  ];
  const report = await runAgent({ base, source, workspace: "git", apply: true, maxRounds: 5, reply: async () => replies.shift() ?? done });
  assert.equal(report.status, "passed");
  assert.deepEqual(report.changed_files, ["answer.js"], ".gitignore 中的 build/ 不算改动");
  assert.match(report.branch!, /^forge\//);
  assert.equal(report.applied, true);
  assert.match(report.applied_commit!, /^[0-9a-f]{40}$/);
  assert.equal(gitIn(source, "rev-parse", report.branch!).trim(), report.applied_commit);
  assert.equal(gitIn(source, "diff", "--name-only", "main", report.branch!).trim(), "answer.js");
  assert.equal(await fs.readFile(path.join(source, "answer.js"), "utf8"), "export const answer = 0;\n", "用户的检出不变");
  assert.equal(gitIn(source, "status", "--porcelain").trim(), "");
  assert.equal(report.task.options.workspace, "git");
  gitIn(source, "worktree", "remove", "--force", report.workspace);
});

test("git mode refuses non-repositories, subdirectories and uncommitted changes", async t => {
  const base = await temp(t);
  await assert.rejects(createWorkspace(await project(path.join(base, "plain")), base, "git"), /git 仓库/);
  const source = await repo(path.join(base, "source"));
  await fs.mkdir(path.join(source, "sub"));
  await assert.rejects(createWorkspace(path.join(source, "sub"), base, "git"), /仓库根目录/);
  await fs.writeFile(path.join(source, "answer.js"), "changed");
  await assert.rejects(createWorkspace(source, base, "git"), /未提交的修改/);
});

test("listFiles in a worktree follows .gitignore and skips deleted tracked files", async t => {
  const base = await temp(t);
  const source = await repo(path.join(base, "source"));
  // The temp directory cleanup removes the worktree together with its repository.
  const { projectDir } = await createWorkspace(source, base, "git");
  await fs.mkdir(path.join(projectDir, "build"));
  await fs.writeFile(path.join(projectDir, "build", "x.js"), "");
  await fs.writeFile(path.join(projectDir, "new.js"), "");
  await fs.rm(path.join(projectDir, "answer.js"));
  assert.deepEqual(await listFiles(projectDir), [".gitignore", "answer.test.js", "new.js", "package.json"]);
});

test("setup runs before the baseline; a failing setup stops the run before any model call", async t => {
  const base = await temp(t);
  const source = await project(path.join(base, "source"));
  const ok = await runAgent({ base, source, setupCommand: "echo ready > setup-marker.txt", maxRounds: 1, reply: async () => done });
  assert.equal(ok.setup?.exit_code, 0);
  assert.ok(!ok.changed_files.includes("setup-marker.txt"), "准备命令产生的文件不算 Agent 的改动");
  let called = false;
  const failed = await runAgent({ base, source, setupCommand: "exit 3", reply: async () => { called = true; return done; } });
  assert.equal(failed.status, "error");
  assert.equal(failed.termination.reason, "setup_error");
  assert.match(failed.termination.error!, /退出码 3/);
  assert.equal(called, false);
});

test("a custom test command verifies the task and refuses partial runs", async t => {
  const base = await temp(t);
  const source = await project(path.join(base, "source"));
  const testConfig = { command: "node --test answer.test.js" };
  await assert.rejects(runTests(source, undefined, { target: "answer.test.js" }, testConfig), /自定义测试命令/);
  const replies = [call("e", "edit_file", { relative_path: "answer.js", old_str: "= 0", new_str: "= 42" }), call("t", "run_tests"), plan, done];
  const report = await runAgent({ base, source, testConfig, maxRounds: 4, reply: async () => replies.shift() ?? done });
  assert.equal(report.status, "passed");
  assert.equal(report.tests.baseline!.status, "failed");
  assert.deepEqual(report.task.options.test_config, testConfig);
});

test("docker arguments isolate the run: no network, limits, project mount, preserved paths, read-only mounts", () => {
  const args = dockerRunArgs({ image: "node:24", workdir: "/app", preserve: ["/app/node_modules"], mounts: [{ host: "/s", container: "/forge" }] },
    "/p", "forge-1", ["node", "--test"]);
  assert.deepEqual(args, [
    "run", "--rm", "--name", "forge-1", "--network", "none", "--cpus", "2", "--memory", "2g", "--pids-limit", "512",
    "--security-opt", "no-new-privileges", "-v", "/p:/app", "-v", "/app/node_modules", "-v", "/s:/forge:ro",
    "-w", "/app", "node:24", "node", "--test",
  ]);
  assert.ok(!dockerRunArgs({ image: "x", network: true }, "/p", "n", []).includes("--network"));
});

// A stand-in docker binary: logs its arguments, prints a passing summary, or hangs to test timeouts.
async function fakeDocker(t: any, dir: string) {
  const bin = path.join(dir, "fake-docker");
  const log = path.join(dir, "docker.log");
  await fs.writeFile(bin, `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "run" && process.env.FAKE_DOCKER_HANG) setTimeout(() => {}, 20000);
else console.log("ℹ pass 1");
`, { mode: 0o755 });
  const previous = process.env.DOCKER;
  process.env.DOCKER = bin;
  t.after(() => { if (previous === undefined) delete process.env.DOCKER; else process.env.DOCKER = previous; delete process.env.FAKE_DOCKER_HANG; });
  return async () => (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

test("sandboxed tests run through docker with in-image interpreters, and a timeout kills the container", async t => {
  const dir = await temp(t);
  const root = await project(path.join(dir, "p"));
  const calls = await fakeDocker(t, dir);
  const sandbox = { image: "node:24" };
  const result = await runTests(root, undefined, {}, { sandbox });
  assert.equal(result.exit_code, 0);
  const [run] = await calls();
  assert.equal(run[0], "run");
  assert.ok(run.includes("--network") && run.includes(`${await fs.realpath(root)}:/workspace`));
  assert.deepEqual(run.slice(run.indexOf("node:24") + 1), ["node", "--test", "answer.test.js"], "容器里用镜像自带的 node");

  process.env.FAKE_DOCKER_HANG = "1";
  const slow = await runTests(root, 300, {}, { sandbox });
  assert.equal(slow.time_out, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  const log = await calls();
  const name = log[1][log[1].indexOf("--name") + 1];
  assert.deepEqual(log.at(-1), ["kill", name], "超时后按名字停止容器");
});

test("MCP server receives the test configuration explicitly", async t => {
  const dir = await temp(t);
  const root = await project(path.join(dir, "p"));
  const client = new MCPClient(new URL("../src/mcp/server.ts", import.meta.url), root, undefined, { command: "echo custom-runner" });
  try {
    const result = await client.callTool("run_tests", {}) as any;
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /custom-runner/);
  } finally {
    await client.close();
  }
});

const INFO = `Instance ID: instance_x
Repository: org/repo
Base Commit: abc123
Test Files: ["test/a.js"]
FAIL_TO_PASS: ["test/a.js | fixed case"]
PASS_TO_PASS: ["test/a.js | kept case", "test/a.js | other kept"]
`;

test("SWE-bench Pro: instance info parsing, task lookup, sandboxed official script and grading", async t => {
  const info = parseInstanceInfo(INFO);
  assert.deepEqual(info.failToPass, ["test/a.js | fixed case"]);
  assert.throws(() => parseInstanceInfo("Instance ID: x"), /缺少字段：Repository/);

  const dir = await temp(t);
  const scripts = path.join(dir, "pro", "run_scripts", "instance_x");
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(path.join(scripts, "instance_info.txt"), INFO);
  await fs.writeFile(path.join(scripts, "run_script.sh"), "");
  await fs.writeFile(path.join(scripts, "parser.py"), "");
  const tasks = path.join(dir, "tasks");
  await fs.mkdir(path.join(tasks, "demo"), { recursive: true });
  await fs.writeFile(path.join(tasks, "demo", "metadata.json"), JSON.stringify({ instance_id: "instance_x", docker_image: "img:1", repository_in_container: "/app" }));
  await fs.writeFile(path.join(tasks, "demo", "instruction.md"), "修复问题");
  const task = await loadSweTask(path.join(dir, "pro"), "instance_x", tasks);
  assert.equal(task.image, "img:1");
  await assert.rejects(loadSweTask(path.join(dir, "pro"), "instance_y", tasks), /instance_info/);

  const config = sweTestConfig(task);
  assert.equal(config.command, "bash /forge-swe/run_script.sh 'test/a.js'");
  assert.deepEqual(config.sandbox?.preserve, ["/app/node_modules"]);
  assert.deepEqual(config.sandbox?.mounts, [{ host: scripts, container: "/forge-swe" }]);
  assert.equal(config.sandbox?.network, undefined, "默认断网");

  const all = [{ name: "test/a.js | fixed case", status: "PASSED" }, { name: "test/a.js | kept case", status: "PASSED" }, { name: "test/a.js | other kept", status: "PASSED" }];
  assert.equal(grade(all, info.failToPass, info.passToPass).resolved, true);
  const missing = grade(all.slice(0, 2), info.failToPass, info.passToPass);
  assert.equal(missing.resolved, false, "没有运行的用例算失败");
  assert.deepEqual(missing.pass_to_pass.failed, ["test/a.js | other kept"]);
});
