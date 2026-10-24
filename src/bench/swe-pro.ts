import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "../config.js";
import { runAgent, type AgentOptions } from "../agent.js";
import { runProcess, type TestConfig } from "../tools.js";

// SWE-bench Pro: the repository lives in the task image at /app. Tests run with the official
// run_script.sh inside that image; parser.py turns the output into per-test results, and the
// task is resolved only when every FAIL_TO_PASS and PASS_TO_PASS test passes.

export interface InstanceInfo {
  instanceId: string;
  repo: string;
  baseCommit: string;
  testFiles: string[];
  failToPass: string[];
  passToPass: string[];
}

export function parseInstanceInfo(text: string): InstanceInfo {
  const field = (name: string) => {
    const match = text.match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
    if (!match) throw new Error(`instance_info.txt 缺少字段：${name}`);
    return match[1].trim();
  };
  const list = (name: string) => {
    const value = JSON.parse(field(name));
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} 必须是字符串数组`);
    return value as string[];
  };
  return {
    instanceId: field("Instance ID"),
    repo: field("Repository"),
    baseCommit: field("Base Commit"),
    testFiles: list("Test Files"),
    failToPass: list("FAIL_TO_PASS"),
    passToPass: list("PASS_TO_PASS"),
  };
}

export interface SweTask {
  info: InstanceInfo;
  scriptsDir: string;
  instruction: string;
  image: string;
  workdir: string;
}

/** Find the instance's official scripts and the local task folder whose metadata names it. */
export async function loadSweTask(proDir: string, instanceId: string, tasksRoot = path.join(ROOT, "tasks", "swe-bench-pro")): Promise<SweTask> {
  const scriptsDir = path.join(path.resolve(proDir), "run_scripts", instanceId);
  const info = parseInstanceInfo(await fs.readFile(path.join(scriptsDir, "instance_info.txt"), "utf8"));
  for (const required of ["run_script.sh", "parser.py"]) await fs.access(path.join(scriptsDir, required));
  for (const name of await fs.readdir(tasksRoot)) {
    const dir = path.join(tasksRoot, name);
    const metadata = JSON.parse(await fs.readFile(path.join(dir, "metadata.json"), "utf8").catch(() => "{}"));
    if (metadata.instance_id !== instanceId) continue;
    if (!metadata.docker_image) throw new Error(`任务 ${name} 的 metadata.json 缺少 docker_image`);
    return {
      info, scriptsDir,
      instruction: await fs.readFile(path.join(dir, "instruction.md"), "utf8"),
      image: metadata.docker_image,
      workdir: metadata.repository_in_container ?? "/app",
    };
  }
  throw new Error(`在 ${tasksRoot} 中没有找到 instance_id 为 ${instanceId} 的任务`);
}

const SCRIPTS_MOUNT = "/forge-swe";

/** Tests run inside the task image: official script, dependencies kept from the image, no network. */
export function sweTestConfig(task: SweTask): TestConfig {
  return {
    command: `bash ${SCRIPTS_MOUNT}/run_script.sh ${shellQuote(task.info.testFiles.join(","))}`,
    timeoutMs: 1_800_000,
    sandbox: {
      image: task.image,
      workdir: task.workdir,
      memory: "4g",
      preserve: [`${task.workdir}/node_modules`],
      mounts: [{ host: task.scriptsDir, container: SCRIPTS_MOUNT }],
    },
  };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export type ParsedTest = { name: string; status: string };

/** Missing tests count as failures: a test that did not run was not shown to pass. */
export function grade(tests: ParsedTest[], failToPass: string[], passToPass: string[]) {
  const passed = new Set(tests.filter((test) => test.status === "PASSED").map((test) => test.name));
  const split = (names: string[]) => ({
    passed: names.filter((name) => passed.has(name)),
    failed: names.filter((name) => !passed.has(name)),
  });
  const f2p = split(failToPass), p2p = split(passToPass);
  return { resolved: f2p.failed.length === 0 && p2p.failed.length === 0, fail_to_pass: f2p, pass_to_pass: p2p };
}

/** Copy the repository out of the image without dependencies (they stay in the image and are mounted back). */
export async function exportRepository(image: string, workdir: string, dest: string) {
  await fs.mkdir(dest, { recursive: true });
  const docker = process.env.DOCKER ?? "docker";
  await new Promise<void>((resolve, reject) => {
    const source = spawn(docker, ["run", "--rm", "--network", "none", "--entrypoint", "tar", image,
      "-C", workdir, "--exclude=./node_modules", "--exclude=./.git", "-cf", "-", "."], { stdio: ["ignore", "pipe", "inherit"] });
    const sink = spawn("tar", ["-xf", "-", "-C", dest], { stdio: ["pipe", "inherit", "inherit"] });
    source.stdout.pipe(sink.stdin);
    let failed = false;
    const fail = (error: Error) => { if (!failed) { failed = true; reject(error); } };
    source.on("error", fail);
    sink.on("error", fail);
    source.on("close", (code) => { if (code !== 0) fail(new Error(`从镜像导出仓库失败（docker 退出码 ${code}）`)); });
    sink.on("close", (code) => { if (code !== 0) fail(new Error(`解包仓库失败（tar 退出码 ${code}）`)); else if (!failed) resolve(); });
  });
}

/** Run the official parser on saved output and read back per-test results. */
export async function parseOfficial(scriptsDir: string, outDir: string, stdout: string, stderr: string): Promise<ParsedTest[]> {
  const files = { out: path.join(outDir, "swe-stdout.txt"), err: path.join(outDir, "swe-stderr.txt"), json: path.join(outDir, "swe-parsed.json") };
  await fs.writeFile(files.out, stdout);
  await fs.writeFile(files.err, stderr);
  const result = await runProcess(outDir, [process.env.PYTHON ?? "python3", path.join(scriptsDir, "parser.py"), files.out, files.err, files.json], 120000);
  if (result.exit_code !== 0) throw new Error(`parser.py 失败：${result.stderr.slice(-2000)}`);
  const parsed = JSON.parse(await fs.readFile(files.json, "utf8"));
  return Array.isArray(parsed.tests) ? parsed.tests : [];
}

/**
 * Prepare (or reuse) the exported repository, let the agent work with official tests in the image,
 * then grade the final code with one more official run. Requires Docker.
 */
export async function runSweTask(proDir: string, instanceId: string, agentOptions: AgentOptions = {}) {
  const task = await loadSweTask(proDir, instanceId);
  const base = agentOptions.base ?? ROOT;
  const source = path.join(base, "swe-sources", instanceId);
  const docker = await runProcess(base, [process.env.DOCKER ?? "docker", "version", "--format", "{{.Server.Version}}"], 30000);
  if (docker.exit_code !== 0)
    throw new Error(`SWE-bench Pro 需要可用的 Docker（未找到 docker 命令或 Docker 未启动）：${(docker.stderr || docker.stdout).trim().slice(0, 300)}`);
  if (!(await fs.access(source).then(() => true, () => false))) {
    console.log(`从镜像导出仓库：${task.image}`);
    const partial = source + ".partial";
    await fs.rm(partial, { recursive: true, force: true });
    try {
      await exportRepository(task.image, task.workdir, partial);
    } catch (error) {
      await fs.rm(partial, { recursive: true, force: true });
      throw error;
    }
    await fs.rename(partial, source);
  }
  const testConfig = sweTestConfig(task);
  const instruction = task.instruction.replaceAll(`\`${task.workdir}\``, "当前工作目录") +
    `\n\n（说明：仓库已复制到你的工作目录；测试会在任务镜像中的 ${task.workdir} 运行。）`;
  const report = await runAgent({ ...agentOptions, base, source, task: instruction, testConfig, workspace: "copy" });

  const final = await runProcess(report.workspace, ["sh", "-c", testConfig.command!], testConfig.timeoutMs!, testConfig.sandbox);
  const tests = await parseOfficial(task.scriptsDir, report.task_dir, final.stdout, final.stderr);
  const result = { instance_id: instanceId, image: task.image, agent_status: report.status, ...grade(tests, task.info.failToPass, task.info.passToPass) };
  await fs.writeFile(path.join(report.task_dir, "swe-report.json"), JSON.stringify(result, null, 2));
  console.log(`SWE-bench Pro：${result.resolved ? "已解决" : "未解决"}；FAIL_TO_PASS 通过 ${result.fail_to_pass.passed.length}/${task.info.failToPass.length}，PASS_TO_PASS 通过 ${result.pass_to_pass.passed.length}/${task.info.passToPass.length}`);
  return result;
}
