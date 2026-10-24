import { promises as fs } from "node:fs";
import path from "node:path";
import type { Message } from "./types.js";

/** Load a complete API recording before any tools execute. */
export async function loadReplay(directory: string) {
  directory = path.resolve(directory);
  const modelDir = path.basename(directory) === "model" ? directory : path.join(directory, "model");
  const rounds = (await fs.readdir(modelDir)).filter(name => /^round-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  if (!rounds.length) throw new Error("回放目录没有模型轮次");
  const messages: Message[] = [];
  for (const [index, name] of rounds.entries()) {
    if (Number(name.slice(6)) !== index + 1) throw new Error(`回放轮次不连续：${name}`);
    const dir = path.join(modelDir, name);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    if (meta.mode !== "api" || meta.status !== "completed")
      throw new Error(`回放需要已完成的真实 API 记录：${name}`);
    const response = JSON.parse(await fs.readFile(path.join(dir, "response.json"), "utf8"));
    const raw = response.choices?.[0]?.message;
    if (!raw || raw.role !== "assistant" || (raw.content != null && typeof raw.content !== "string") ||
        (raw.tool_calls !== undefined && (!Array.isArray(raw.tool_calls) || raw.tool_calls.some((call: any) =>
          !call || typeof call.id !== "string" || call.type !== "function" ||
          typeof call.function?.name !== "string" || typeof call.function?.arguments !== "string"))))
      throw new Error(`回放响应格式无效：${name}`);
    messages.push({ role: "assistant", content: raw.content ?? null,
      ...(raw.tool_calls ? { tool_calls: raw.tool_calls } : {}) });
  }
  const request = JSON.parse(await fs.readFile(path.join(modelDir, rounds[0], "request.json"), "utf8"));
  const task = request.messages?.find((message: Message) => message.role === "user")?.content;
  let cursor = 0;
  return {
    directory, length: messages.length, task: typeof task === "string" ? task : undefined,
    next(): Message {
      if (cursor >= messages.length) throw new Error("回放数据已耗尽，任务仍未通过结束检查；请检查初始项目、任务和工具结果是否匹配录制环境");
      return structuredClone(messages[cursor++]);
    },
  };
}
