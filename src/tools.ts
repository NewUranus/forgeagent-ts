import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { listFiles, projectPath } from "./workspace.js";
import type { TestResult, ToolDefinition } from "./types.js";
const schema = (properties = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const tools: ToolDefinition[] = [
  {
    name: "list_files",
    description: "列举工作副本文件",
    inputSchema: schema(),
  },
  {
    name: "read_file",
    description: "读取相对路径文件",
    inputSchema: schema({ relative_path: { type: "string" } }, [
      "relative_path",
    ]),
  },
  {
    name: "write_file",
    description: "写入源文件，禁止修改测试文件",
    inputSchema: schema(
      { relative_path: { type: "string" }, content: { type: "string" } },
      ["relative_path", "content"],
    ),
  },
  { name: "run_tests", description: "执行项目测试", inputSchema: schema() },
  {
    name: "search_code",
    description: "在源文件中搜索文字",
    inputSchema: schema({ keyword: { type: "string" } }, ["keyword"]),
  },
  {
    name: "update_plan",
    description: "保存任务步骤",
    inputSchema: schema(
      {
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                minLength: 1,
                description: "步骤的标识",
              },
              description: {
                type: "string",
                minLength: 1,
                description: "这一步要做的事情",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "description", "status"],
            additionalProperties: false,
          },
        },
      },
      ["steps"],
    ),
  },
];
export function isTestFile(name: string) {
  return /(^|\/)(test[s]?|__tests__)(\/|\.)|(^|\/)test_|[._](test|spec)\.[^.]+$/.test(
    name,
  );
}
export async function runTests(
  root: string,
  timeout = 30000,
): Promise<TestResult> {
  const files = await listFiles(root);
  const tests = files.filter((f) => /\.(test|spec)\.(ts|js)$/.test(f));
  const python =
    tests.length === 0 && files.some((f) => /(^|\/)test_.*\.py$/.test(f));
  if (!tests.length && !python)
    return {
      exit_code: 2,
      time_out: false,
      stdout: "",
      stderr: "没有找到测试文件",
    };
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(
      python ? (process.env.PYTHON ?? "python3") : process.execPath,
      python ? ["-m", "pytest", "-v"] : ["--test", ...tests],
      {
        cwd: root,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      time_out = false;
    child.stdout.on("data", (b) => {
      stdout = (stdout + b).slice(-200000);
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-200000);
    });
    const timer = setTimeout(() => {
      time_out = true;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exit_code: null, time_out, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code, time_out, stdout, stderr });
    });
  });
}
function stringArg(args: Record<string, unknown>, name: string) {
  if (typeof args[name] !== "string") throw new Error(`${name} 必须是字符串`);
  return args[name] as string;
}
export async function executeTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const definition = tools.find((t) => t.name === name);
  if (!definition) throw new Error(`未知工具：${name}`);
  const allowed = Object.keys(definition.inputSchema.properties as object);
  if (Object.keys(args).some((k) => !allowed.includes(k)))
    throw new Error("存在未知参数");
  switch (name) {
    case "list_files":
      return listFiles(root);
    case "read_file":
      return fs.readFile(
        await projectPath(root, stringArg(args, "relative_path")),
        "utf8",
      );
    case "write_file": {
      const relative = stringArg(args, "relative_path");
      const file = await projectPath(root, relative, true);
      if (isTestFile(path.relative(root, file).split(path.sep).join("/")))
        throw new Error("禁止修改测试文件");
      const content = stringArg(args, "content");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      return `已写入 ${relative}`;
    }
    case "run_tests":
      return runTests(root);
    case "search_code": {
      const keyword = stringArg(args, "keyword");
      if (!keyword.trim()) throw new Error("关键词不能为空");
      const matches = [];
      for (const file of await listFiles(root)) {
        if (!/\.(ts|js|py|md)$/.test(file)) continue;
        const lines = (await fs.readFile(path.join(root, file), "utf8")).split(
          "\n",
        );
        for (const [i, text] of lines.entries())
          if (text.includes(keyword))
            matches.push({ path: file, line: i + 1, text });
      }
      return matches.slice(0, 100);
    }
    case "update_plan": {
      const steps = args.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error("steps 必须是非空数组");
      }
      const ids = new Set<string>();
      const validStatuses = new Set([
        "pending",
        "in_progress",
        "completed",
      ]);

      let inProgressCount = 0;

      for (const step of steps) {
        if (step === null || typeof step !== "object" || Array.isArray(step)) {
          throw new Error("每一步必须是对象");
        }

        if (typeof step.id !== "string" || !step.id.trim()) {
          throw new Error("步骤 id 必须是非空字符串");
        }

        if (ids.has(step.id)) {
          throw new Error(`步骤 id 重复：${step.id}`);
        }

        ids.add(step.id);

        if (typeof step.description !== "string" || !step.description.trim()) {
          throw new Error("步骤 description 必须是非空字符串");
        }

        // 状态检查
        if(typeof step.status !== "string" || !validStatuses.has(step.status))
        {
          throw new Error("无效状态")
        }

        if(step.status === "in_progress"){
          inProgressCount ++;
        }

      }

      // 只能有一个step是in_progress
      if(inProgressCount > 1){
        throw new Error("最多只能有一个步骤处于in_progress")
      }
      
      const plan = { steps: args.steps, updated_at: new Date().toISOString() };
      // root is the code copy: <taskDir>/project. Keep artifacts outside it.
      const taskDir = path.dirname(root);
      await fs.writeFile(path.join(taskDir, "plan.json"), JSON.stringify(plan, null, 2));
      await fs.appendFile(path.join(taskDir, "plans.jsonl"), JSON.stringify(plan) + "\n");
      return plan;
    }
  }
}
