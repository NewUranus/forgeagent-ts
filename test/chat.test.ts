import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ChatSession, extractCodeBlocks, isFenceOpen, renderFindings, validateFindings, type Finding } from "../src/chat.ts";
import { changedLines, hitsBug } from "../src/eval/review.ts";
import type { Message, ToolDefinition } from "../src/types.ts";

let ids = 0;
const calls = (...list: [string, object?][]): Message => ({ role: "assistant", content: null,
  tool_calls: list.map(([name, args = {}]) => ({ id: `c${++ids}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })) });
const call = (name: string, args = {}) => calls([name, args]);
const say = (content: string): Message => ({ role: "assistant", content });
const toolResults = (messages: Message[]) => messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content!));

const SUM = [
  "export function sum(items: number[]) {",
  "  let total = 0;",
  "  for (let i = 0; i <= items.length; i++) total += items[i];",
  "  return total;",
  "}",
].join("\n") + "\n";
const ASK_SUM = "这段代码有什么问题？\n```ts\n" + SUM + "```";
const FINDING: Finding = {
  file: "snippets/snippet-1.ts", line: 3, severity: "error", title: "循环越界",
  explanation: "i <= items.length 会多读一个 undefined，结果变成 NaN", suggestion: "改成 i < items.length",
  evidence: "for (let i = 0; i <= items.length; i++)",
};

async function tmp(t: any) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-chat-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

/** A scripted model that records every request it gets. */
function script(queue: Message[]) {
  const seen: { messages: Message[]; tools: string[] }[] = [];
  const reply = async (messages: Message[], tools: ToolDefinition[]) => {
    seen.push({ messages: structuredClone(messages), tools: tools.map((tool) => tool.name).sort() });
    return queue.shift() ?? say("（脚本已用完）");
  };
  return { reply, seen, last: () => seen.at(-1)!.messages };
}

test("extractCodeBlocks pulls fenced code out of the message", () => {
  const { text, blocks } = extractCodeBlocks("看看这个\n```TS\nconst a = 1;\n```\n还有\n  ```\nprint(1)\nprint(2)\n  ```\n");
  assert.deepEqual(blocks, [{ language: "ts", content: "const a = 1;\n" }, { language: "", content: "print(1)\nprint(2)\n" }]);
  assert.match(text, /看看这个/);
  assert.match(text, /还有/);
  assert.doesNotMatch(text, /const a = 1|print\(1\)|```/);
  assert.deepEqual(extractCodeBlocks("没有代码").blocks, []);
});

test("isFenceOpen tells the prompt whether to keep reading lines", () => {
  assert.equal(isFenceOpen("```ts\nfoo"), true);
  assert.equal(isFenceOpen("```ts\nfoo\n```"), false);
  assert.equal(isFenceOpen("没有代码"), false);
  assert.equal(isFenceOpen("用 ```ts 包起来"), false);
  assert.equal(isFenceOpen("```\na\n```\n说明\n```py"), true);
});

test("a pasted snippet is saved, shown with line numbers, and reviewed with checked findings", async (t) => {
  const base = await tmp(t);
  const s = script([call("report_findings", { findings: [FINDING] }), say("第 3 行越界：应为 <")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true });
  const turn = await chat.ask(ASK_SUM);

  assert.equal(turn.status, "answered");
  assert.equal(turn.answer, "第 3 行越界：应为 <");
  assert.deepEqual(turn.findings, [FINDING]);
  assert.deepEqual(turn.attachments, ["snippets/snippet-1.ts"]);
  assert.equal(turn.rounds, 2);
  assert.equal(turn.tool_calls, 1);
  assert.equal(await fs.readFile(path.join(chat.projectDir, "snippets/snippet-1.ts"), "utf8"), SUM);
  assert.ok(chat.projectDir.startsWith(base));

  const question = s.seen[0].messages.at(-1)!;
  assert.equal(question.role, "user");
  assert.match(question.content!, /这段代码有什么问题/);
  assert.match(question.content!, /snippets\/snippet-1\.ts（共 5 行）/);
  assert.ok(question.content!.includes("3\t  for (let i = 0; i <= items.length; i++)"));
  assert.doesNotMatch(question.content!, /```/);

  const offered = s.seen[0].tools;
  for (const name of ["list_files", "find_files", "read_file", "search_code", "check_syntax", "report_findings"]) assert.ok(offered.includes(name), name);
  for (const name of ["write_file", "edit_file", "update_plan", "run_tests", "agent"]) assert.ok(!offered.includes(name), name);

  assert.deepEqual(toolResults(s.last()), [{ ok: true, result: "已记录 1 条问题" }]);
});

test("a finding whose evidence is not on the cited line is refused with where it really is", async (t) => {
  const base = await tmp(t);
  const s = script([call("report_findings", { findings: [{ ...FINDING, line: 2 }] }), call("report_findings", { findings: [FINDING] }), say("改好了引用")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true });
  const turn = await chat.ask(ASK_SUM);
  const [refused, accepted] = toolResults(s.last());
  assert.equal(refused.ok, false);
  assert.match(refused.error, /第 1 条：evidence 不在 snippets\/snippet-1\.ts 第 2 行，它出现在第 3 行/);
  assert.equal(accepted.ok, true);
  assert.deepEqual(turn.findings, [FINDING]);
});

test("validateFindings checks fields, file, range and evidence", async (t) => {
  const dir = await tmp(t);
  await fs.writeFile(path.join(dir, "a.ts"), SUM);
  const ok = { ...FINDING, file: "a.ts" };
  assert.deepEqual(await validateFindings(dir, []), []);
  assert.deepEqual(await validateFindings(dir, [ok]), []);
  // Whitespace is normalized; a multi-line quote may span its cited range.
  assert.deepEqual(await validateFindings(dir, [{ ...ok, evidence: "for (let i = 0;   i <= items.length;" }]), []);
  assert.deepEqual(await validateFindings(dir, [{ ...ok, line: 2, end_line: 3, evidence: "let total = 0;\n  for (let i = 0;" }]), []);
  const { suggestion, ...withoutSuggestion } = ok;
  assert.deepEqual(await validateFindings(dir, [withoutSuggestion]), []);

  const bad = async (finding: object) => {
    const errors = await validateFindings(dir, [ok, finding]);
    assert.equal(errors.length, 1, JSON.stringify(finding));
    assert.match(errors[0], /^第 2 条：/);
    return errors[0];
  };
  assert.match(await bad({ ...ok, file: "nope.ts" }), /找不到文件 nope\.ts/);
  await bad({ ...ok, file: "../a.ts" });
  await bad({ ...ok, line: 9 });
  await bad({ ...ok, line: 0 });
  await bad({ ...ok, line: 3, end_line: 2 });
  await bad({ ...ok, severity: "fatal" });
  await bad({ ...ok, title: "  " });
  await bad({ ...ok, evidence: "" });
  await bad({ ...ok, extra: 1 });
  const { explanation, ...withoutExplanation } = ok;
  await bad(withoutExplanation);
  assert.match(await bad({ ...ok, evidence: "return items.length;" }), /evidence 不在 a\.ts 第 3 行，文件中也找不到这段代码/);
  assert.match(await bad({ ...ok, line: 4, end_line: 5, evidence: "let total = 0;" }), /第 4-5 行，它出现在第 2 行/);
  assert.deepEqual(await validateFindings(dir, "x"), ["findings 必须是数组"]);
});

test("write tools are not offered and calling one changes nothing", async (t) => {
  const base = await tmp(t);
  const s = script([call("edit_file", { relative_path: "snippets/snippet-1.ts", old_str: "<=", new_str: "<" }), say("我不能修改文件")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true });
  const turn = await chat.ask(ASK_SUM);
  assert.equal(turn.status, "answered");
  const [result] = toolResults(s.last());
  assert.equal(result.ok, false);
  assert.match(result.error, /未知工具：edit_file/);
  assert.equal(await fs.readFile(path.join(chat.projectDir, "snippets/snippet-1.ts"), "utf8"), SUM);
});

test("follow-up questions keep the history, start with no findings, and are logged to chat.jsonl", async (t) => {
  const base = await tmp(t);
  const s = script([call("report_findings", { findings: [FINDING] }), say("第 3 行越界"), say("因为最后一次 i 等于 length")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true });
  const first = await chat.ask(ASK_SUM);
  const second = await chat.ask("为什么？");
  assert.equal(first.findings.length, 1);
  assert.equal(second.answer, "因为最后一次 i 等于 length");
  assert.deepEqual(second.findings, []);
  assert.deepEqual(second.attachments, []);

  const seen = s.last();
  assert.deepEqual(seen.at(-1), { role: "user", content: "为什么？" });
  assert.ok(seen.some((m) => m.role === "assistant" && m.content === "第 3 行越界"));
  assert.ok(seen.some((m) => m.role === "user" && m.content?.includes("snippets/snippet-1.ts")));

  const log = (await fs.readFile(path.join(chat.taskDir, "chat.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((entry) => entry.turn), [1, 2]);
  assert.equal(log[0].question, ASK_SUM);
  assert.equal(log[0].findings.length, 1);
  assert.equal(log[1].question, "为什么？");
  assert.equal(log[1].status, "answered");
  // Model rounds are numbered across the whole session.
  assert.deepEqual((await fs.readdir(path.join(chat.taskDir, "model"))).sort(), ["round-001", "round-002", "round-003"]);
});

test("reset drops earlier turns but snippet numbering continues", async (t) => {
  const base = await tmp(t);
  const s = script([say("看过了"), say("又看过了")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true });
  await chat.ask(ASK_SUM);
  chat.reset();
  const turn = await chat.ask("再看这个\n```python\nprint(1)\n```");
  assert.deepEqual(turn.attachments, ["snippets/snippet-2.py"]);
  const seen = s.last();
  assert.equal(seen[0].role, "system");
  assert.equal(seen.filter((m) => m.role !== "system").length, 1);
  assert.doesNotMatch(JSON.stringify(seen), /看过了/);
});

test("attachments are stored by basename, renamed on clashes, and never escape the working copy", async (t) => {
  const base = await tmp(t);
  const s = script([say("看过了")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true });
  const turn = await chat.ask("看看", [{ name: "../evil.ts", content: SUM }, { name: "lib/evil.ts", content: "x\n" }]);
  assert.deepEqual(turn.attachments, ["attachments/evil.ts", "attachments/evil-2.ts"]);
  assert.equal(await fs.readFile(path.join(chat.projectDir, "attachments/evil.ts"), "utf8"), SUM);
  assert.equal(await fs.readFile(path.join(chat.projectDir, "attachments/evil-2.ts"), "utf8"), "x\n");
  await assert.rejects(fs.access(path.join(chat.projectDir, "..", "evil.ts")));
  assert.match(s.last().at(-1)!.content!, /attachments\/evil\.ts（共 5 行）/);
});

test("with --source the agent reviews a working copy, can run tests, and leaves the source alone", async (t) => {
  const base = await tmp(t);
  const source = path.join(base, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(source, "answer.js"), "export const answer = 0;\n");
  await fs.writeFile(path.join(source, "answer.test.js"),
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { answer } from "./answer.js"; test("answer is 42", () => assert.equal(answer, 42));');
  const finding = { file: "answer.js", line: 1, severity: "error", title: "值错误", explanation: "测试期望 42", evidence: "export const answer = 0;" };
  const s = script([calls(["read_file", { relative_path: "answer.js" }], ["run_tests", {}]), call("report_findings", { findings: [finding] }), say("answer 应为 42")]);
  const chat = await ChatSession.create({ base, source, reply: s.reply, quiet: true, features: { repoMap: false } });
  const turn = await chat.ask("测试为什么失败？");

  assert.equal(turn.status, "answered");
  assert.deepEqual(turn.findings, [finding]);
  assert.ok(s.seen[0].tools.includes("run_tests"));
  assert.notEqual(chat.projectDir, source);
  const [read, tests, recorded] = toolResults(s.last());
  assert.equal(read.ok, true);
  assert.match(read.result, /answer = 0/);
  assert.equal(tests.ok, true);
  assert.notEqual(tests.result.exit_code, 0);
  assert.equal(recorded.ok, true);
  assert.equal(await fs.readFile(path.join(source, "answer.js"), "utf8"), "export const answer = 0;\n");
});

test("a turn stops at the round limit and the session stays usable", async (t) => {
  const base = await tmp(t);
  const s = script([call("find_files", { pattern: "*.a" }), call("find_files", { pattern: "*.b" }), say("下一轮的回答")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true, maxToolRounds: 2 });
  const turn = await chat.ask("找找");
  assert.equal(turn.status, "round_limit");
  assert.equal(turn.rounds, 2);
  assert.ok(turn.answer.trim().length > 0);
  const next = await chat.ask("继续");
  assert.equal(next.status, "answered");
  assert.equal(next.answer, "下一轮的回答");
});

test("repeating the same call stops the turn as a loop", async (t) => {
  const base = await tmp(t);
  const s = script([call("list_files"), call("list_files"), call("list_files"), say("不该走到这里")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true });
  const turn = await chat.ask("看看有什么文件");
  assert.equal(turn.status, "loop_detected");
  assert.equal(turn.rounds, 3);
  assert.equal(turn.tool_calls, 3);
  assert.ok(turn.answer.trim().length > 0);
});

test("check_syntax reports parse errors in a snippet", async (t) => {
  const base = await tmp(t);
  const s = script([call("check_syntax", { relative_path: "snippets/snippet-1.ts" }), call("check_syntax", { relative_path: "snippets/snippet-2.txt" }), say("第 1 行语法错误")]);
  const chat = await ChatSession.create({ base, reply: s.reply, quiet: true });
  await chat.ask("```ts\nconst a = ;\n```\n```\nplain\n```");
  const [ts, txt] = toolResults(s.last());
  assert.equal(ts.ok, true);
  assert.match(ts.result, /^语法检查发现 \d+ 个问题：/);
  assert.match(ts.result, /第 1 行/);
  assert.equal(txt.ok, true);
  assert.equal(txt.result, "不支持该文件类型的语法检查");
});

test("renderFindings prints a numbered list with location and quoted code", () => {
  assert.equal(renderFindings([]), "未发现问题。");
  const text = renderFindings([FINDING, { ...FINDING, severity: "warning", line: 3, end_line: 4, title: "第二个" }]);
  assert.match(text, /发现 2 个问题/);
  assert.ok(text.includes("1. [error] snippets/snippet-1.ts:3 — 循环越界"));
  assert.ok(text.includes("代码：for (let i = 0; i <= items.length; i++)"));
  assert.ok(text.includes("2. [warning] snippets/snippet-1.ts:3-4 — 第二个"));
  assert.ok(text.includes("改成 i < items.length"));
});

test("changedLines finds the buggy lines a fix touches", () => {
  assert.deepEqual(changedLines("a\nb\nc\n", "a\nB\nc\n"), [2]);
  assert.deepEqual(changedLines("a\nb\nc\n", "a\nc\n"), [2]);
  assert.deepEqual(changedLines("a\nc\n", "a\nb\nc\n"), [1]);
  assert.deepEqual(changedLines("b\n", "a\nb\n"), [1]);
  assert.deepEqual(changedLines("a\nb\nc\nd\n", "a\nB\nc\nD\n"), [2, 4]);
  assert.deepEqual(changedLines("a\nb\n", "a\nb\n"), []);
});

test("every eval task has a buggy file with changed lines", async () => {
  const tasksDir = path.join(import.meta.dirname, "..", "eval", "tasks");
  for (const task of await fs.readdir(tasksDir)) {
    const solution = path.join(tasksDir, task, "solution");
    let found = false;
    for (const file of await fs.readdir(solution)) {
      const lines = changedLines(await fs.readFile(path.join(tasksDir, task, "project", file), "utf8"), await fs.readFile(path.join(solution, file), "utf8"));
      if (lines.length) found = true;
    }
    assert.ok(found, task);
  }
});

test("hitsBug matches a finding near a changed line in the same file", () => {
  const at = (line: number, end_line?: number): Finding => ({ ...FINDING, file: "attachments/x.ts", line, ...(end_line ? { end_line } : {}) });
  assert.equal(hitsBug([at(5)], "attachments/x.ts", [6]), true);
  assert.equal(hitsBug([at(5)], "attachments/x.ts", [8]), false);
  assert.equal(hitsBug([at(5)], "attachments/x.ts", [6], 0), false);
  assert.equal(hitsBug([at(3, 5)], "attachments/x.ts", [6]), true);
  assert.equal(hitsBug([at(3, 5)], "attachments/x.ts", [4], 0), true);
  assert.equal(hitsBug([at(5)], "attachments/y.ts", [5]), false);
  assert.equal(hitsBug([], "attachments/x.ts", [5]), false);
});
