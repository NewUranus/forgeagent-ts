import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { listFiles, projectPath } from "./workspace.js";
import type { TestResult, ToolDefinition } from "./types.js";
const MAX_READ_LINES = 400;
const MAX_LINE_CHARS = 1000;
const MAX_SEARCH_RESULTS = 100;
const MAX_FIND_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
// Tools that can change the working copy; any call invalidates earlier test verification.
export const writeTools = new Set(["write_file", "edit_file"]);
const schema =(properties = {}, required: string[] = []) => ({
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
    description: `读取相对路径文件。每行带“行号+制表符”前缀，前缀不属于文件内容。单次最多返回 ${MAX_READ_LINES} 行，可用 start_line/end_line（从 1 开始，含两端）分段读取。`,
    inputSchema: schema(
      {
        relative_path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      ["relative_path"],
    ),
  },
  {
    name: "write_file",
    description: "用 content 覆盖整个文件，用于新建文件或大范围重写。修改已有文件优先用 edit_file。禁止修改测试文件。",
    inputSchema: schema(
      { relative_path: { type: "string" }, content: { type: "string" } },
      ["relative_path", "content"],
    ),
  },
  {
    name: "edit_file",
    description: "把已有文件中的 old_str 替换为 new_str。old_str 必须与原文逐字一致（含缩进、不含行号前缀），且在文件中恰好出现一次；不唯一时请带上更多上下文。禁止修改测试文件。",
    inputSchema: schema(
      {
        relative_path: { type: "string" },
        old_str: { type: "string", minLength: 1 },
        new_str: { type: "string" },
      },
      ["relative_path", "old_str", "new_str"],
    ),
  },
  {
    name: "run_tests",
    description: "执行项目测试。不带参数时运行全量测试；target（测试文件，pytest 可用节点 ID）或 name_pattern（测试名正则）只运行部分测试，用于快速检查，不能代替结束前的全量验证。",
    inputSchema: schema({
      target: { type: "string" },
      name_pattern: { type: "string" },
    }),
  },
  {
    name: "search_code",
    description: `在文本文件中逐行搜索。regex 为 true 时 keyword 按正则匹配；glob 过滤文件路径；context_lines 返回前后若干行。最多返回 ${MAX_SEARCH_RESULTS} 条。`,
    inputSchema: schema(
      {
        keyword: { type: "string", minLength: 1 },
        regex: { type: "boolean" },
        glob: { type: "string" },
        context_lines: { type: "integer", minimum: 0, maximum: 5 },
      },
      ["keyword"],
    ),
  },
  {
    name: "find_files",
    description: `按 glob 模式查找文件，如 "src/**/*.ts"。模式不含 "/" 时按文件名匹配任意目录。最多返回 ${MAX_FIND_RESULTS} 个。`,
    inputSchema: schema({ pattern: { type: "string", minLength: 1 } }, ["pattern"]),
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
export interface TestSelection {
  target?: string;
  namePattern?: string;
}
// A selection runs only part of the suite; the result is marked partial and never counts as final verification.
export async function runTests(
  root: string,
  timeout = 30000,
  selection: TestSelection = {},
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
  const { target, namePattern } = selection;
  const scope = target !== undefined || namePattern !== undefined ? "partial" : "full";
  if (namePattern !== undefined && !namePattern.trim()) throw new Error("name_pattern 不能为空");
  if (target !== undefined) {
    // pytest node IDs look like "test_x.py::test_name"; only the file part is a path.
    const file = target.split("::")[0];
    if (!python && target.includes("::")) throw new Error("Node 测试的 target 只能是测试文件，按名字筛选请用 name_pattern");
    // projectPath resolves symlinks (e.g. macOS /var -> /private/var), so compare against the real root.
    const relative = path.relative(await fs.realpath(root), await projectPath(root, file)).split(path.sep).join("/");
    if (python ? !/(^|\/)test_.*\.py$/.test(relative) : !tests.includes(relative))
      throw new Error(`target 不是测试文件：${file}`);
  }
  const args = python
    ? ["-m", "pytest", "-v", ...(target ? [target] : []), ...(namePattern ? ["-k", namePattern] : [])]
    : ["--test", ...(namePattern ? [`--test-name-pattern=${namePattern}`] : []), ...(target ? [target] : tests)];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(
      python ? (process.env.PYTHON ?? "python3") : process.execPath,
      args,
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
      resolve({ exit_code: null, time_out, stdout, stderr: e.message, scope });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code, time_out, stdout, stderr, scope });
    });
  });
}
function stringArg(args: Record<string, unknown>, name: string) {
  if (typeof args[name] !== "string") throw new Error(`${name} 必须是字符串`);
  return args[name] as string;
}
function optionalString(args: Record<string, unknown>, name: string) {
  return args[name] === undefined ? undefined : stringArg(args, name);
}
function optionalBoolean(args: Record<string, unknown>, name: string) {
  if (args[name] !== undefined && typeof args[name] !== "boolean") throw new Error(`${name} 必须是布尔值`);
  return args[name] as boolean | undefined;
}
function optionalInteger(args: Record<string, unknown>, name: string, min: number, max = Infinity) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${name} 必须是 ${min}${max === Infinity ? " 及以上" : `–${max}`} 的整数`);
  return value as number;
}
// Without "/", match the file name in any directory, so "*.ts" finds "src/a.ts".
function matchesGlob(file: string, pattern: string) {
  return path.posix.matchesGlob(pattern.includes("/") ? file : path.posix.basename(file), pattern);
}
async function writableFile(root: string, relative: string, mustExist: boolean) {
  const file = await projectPath(root, relative, true);
  if (isTestFile(path.relative(await fs.realpath(root), file).split(path.sep).join("/")))
    throw new Error("禁止修改测试文件");
  if (mustExist && !(await fs.stat(file).then((s) => s.isFile(), () => false)))
    throw new Error(`文件不存在：${relative}。新建文件请用 write_file`);
  return file;
}

/** Render lines as "number<TAB>text", 1-based and inclusive, capped at MAX_READ_LINES per call. */
export function numberLines(content: string, start = 1, end?: number) {
  if (content === "") return "（空文件）";
  const lines = content.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const total = lines.length;
  if (start > total) throw new Error(`start_line 超出范围：文件共 ${total} 行`);
  if (end !== undefined && end < start) throw new Error("end_line 不能小于 start_line");
  const requestedEnd = Math.min(end ?? total, total);
  const last = Math.min(requestedEnd, start + MAX_READ_LINES - 1);
  const width = String(last).length;
  const body = lines
    .slice(start - 1, last)
    .map((line, i) => {
      const text = line.replace(/\r$/, "");
      const shown = text.length > MAX_LINE_CHARS
        ? `${text.slice(0, MAX_LINE_CHARS)}……（本行共 ${text.length} 字符，已截断）`
        : text;
      return `${String(start + i).padStart(width)}\t${shown}`;
    })
    .join("\n");
  return last < requestedEnd
    ? `${body}\n……文件共 ${total} 行，已显示第 ${start}–${last} 行；用 start_line=${last + 1} 继续读取。`
    : body;
}

/** Replace the single occurrence of oldStr. Overlapping matches count, so the target is never ambiguous. */
export function applyEdit(content: string, oldStr: string, newStr: string) {
  if (!oldStr) throw new Error("old_str 不能为空");
  if (oldStr === newStr) throw new Error("old_str 与 new_str 相同，没有需要修改的内容");
  // Keep the file's CRLF style when the model sends LF text.
  if (content.includes("\r\n") && !oldStr.includes("\r")) {
    oldStr = oldStr.replace(/\n/g, "\r\n");
    newStr = newStr.replace(/\r?\n/g, "\r\n");
  }
  const first = content.indexOf(oldStr);
  if (first < 0)
    throw new Error("没有找到 old_str。请确认它与文件内容逐字一致（包括缩进和空白），且没有包含 read_file 的行号前缀。");
  let count = 1;
  for (let i = content.indexOf(oldStr, first + 1); i >= 0; i = content.indexOf(oldStr, i + 1)) count++;
  if (count > 1) throw new Error(`old_str 在文件中出现了 ${count} 次，请加入更多上下文使其唯一。`);
  // slice instead of String.replace: "$&", "$1" and "$$" in newStr must stay literal.
  return {
    content: content.slice(0, first) + newStr + content.slice(first + oldStr.length),
    line: content.slice(0, first).split("\n").length,
  };
}

/** Syntax-only check after a write, so the model sees parse errors in the same round. */
async function syntaxCheck(file: string, content: string): Promise<string> {
  let problems: string[] | null = null;
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) {
    const ts = (await import("typescript")).default;
    const { diagnostics = [] } = ts.transpileModule(content, {
      fileName: path.basename(file),
      reportDiagnostics: true,
      compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve },
    });
    problems = diagnostics
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => {
        const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : "?";
        return `第 ${line} 行：${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
      });
  } else if (file.endsWith(".py")) {
    problems = await pythonSyntax(file, content);
  }
  if (problems === null) return "";
  if (!problems.length) return "；语法检查通过";
  return `；语法检查发现 ${problems.length} 个问题：\n${problems.slice(0, 5).join("\n")}`;
}

// ast.parse reads from stdin, so no .pyc files are written into the working copy.
function pythonSyntax(file: string, content: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.env.PYTHON ?? "python3",
      ["-c", "import ast, sys\ntry:\n    ast.parse(sys.stdin.read(), sys.argv[1])\nexcept SyntaxError as e:\n    print(f'第 {e.lineno} 行：{e.msg}')", path.basename(file)],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", (b) => (stdout += b));
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout.split("\n").filter(Boolean) : null);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(content);
  });
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
    case "read_file": {
      const buffer = await fs.readFile(
        await projectPath(root, stringArg(args, "relative_path")),
      );
      if (buffer.includes(0)) throw new Error("二进制文件，无法读取");
      return numberLines(
        buffer.toString("utf8"),
        optionalInteger(args, "start_line", 1),
        optionalInteger(args, "end_line", 1),
      );
    }
    case "write_file": {
      const relative = stringArg(args, "relative_path");
      const file = await writableFile(root, relative, false);
      const content = stringArg(args, "content");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      return `已写入 ${relative}${await syntaxCheck(file, content)}`;
    }
    case "edit_file": {
      const relative = stringArg(args, "relative_path");
      const file = await writableFile(root, relative, true);
      const edited = applyEdit(
        await fs.readFile(file, "utf8"),
        stringArg(args, "old_str"),
        stringArg(args, "new_str"),
      );
      await fs.writeFile(file, edited.content);
      return `已修改 ${relative} 第 ${edited.line} 行起的内容${await syntaxCheck(file, edited.content)}`;
    }
    case "run_tests":
      return runTests(root, undefined, {
        target: optionalString(args, "target"),
        namePattern: optionalString(args, "name_pattern"),
      });
    case "search_code": {
      const keyword = stringArg(args, "keyword");
      if (!keyword.trim()) throw new Error("关键词不能为空");
      const glob = optionalString(args, "glob");
      const context = optionalInteger(args, "context_lines", 0, 5) ?? 0;
      let matches: (line: string) => boolean = (line) => line.includes(keyword);
      if (optionalBoolean(args, "regex")) {
        let pattern: RegExp;
        try { pattern = new RegExp(keyword); }
        catch (error) { throw new Error(`正则无效：${(error as Error).message}`); }
        matches = (line) => pattern.test(line);
      }
      const results: Record<string, unknown>[] = [];
      let total = 0;
      for (const file of await listFiles(root)) {
        if (glob && !matchesGlob(file, glob)) continue;
        const buffer = await fs.readFile(path.join(root, file));
        if (buffer.length > MAX_SEARCH_FILE_BYTES || buffer.includes(0)) continue;
        const lines = buffer.toString("utf8").split("\n");
        for (const [i, text] of lines.entries()) {
          if (!matches(text)) continue;
          total++;
          if (results.length >= MAX_SEARCH_RESULTS) continue;
          results.push({
            path: file,
            line: i + 1,
            text: text.slice(0, MAX_LINE_CHARS),
            ...(context ? { before: lines.slice(Math.max(0, i - context), i), after: lines.slice(i + 1, i + 1 + context) } : {}),
          });
        }
      }
      return { matches: results, total, truncated: total > results.length };
    }
    case "find_files": {
      const pattern = stringArg(args, "pattern");
      const found = (await listFiles(root)).filter((file) => matchesGlob(file, pattern));
      return { files: found.slice(0, MAX_FIND_RESULTS), total: found.length, truncated: found.length > MAX_FIND_RESULTS };
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
