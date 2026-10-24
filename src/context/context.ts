import type { Message } from "../types.js";

// 启发式估算，包含消息、工具调用参数、工具结果和工具定义；不是精确 tokenizer。
export function estimateRequestToken(
  messages: readonly Message[],
  tools: readonly unknown[],
): number {
  const requestText = JSON.stringify({ messages, tools });
  const bytes = Buffer.byteLength(requestText, "utf8");
  return Math.ceil((bytes / 3) * 1.2) + 128;
}

export class ContextBudgetExceededError extends Error {
  constructor(estimatedTokens: number, inputBudget: number) {
    super(`客户端上下文预算超限：预计输入 ${estimatedTokens} tokens，允许输入 ${inputBudget} tokens`);
    this.name = "ContextBudgetExceededError";
  }
}

export function checkContextBudget(estimatedTokens: number, inputBudget: number): void {
  if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) {
    throw new Error("estimatedTokens 必须是非负安全整数");
  }
  if (!Number.isSafeInteger(inputBudget) || inputBudget <= 0) {
    throw new Error("inputBudget 必须是正安全整数");
  }
  if (estimatedTokens > inputBudget) {
    throw new ContextBudgetExceededError(estimatedTokens, inputBudget);
  }
}

// 把历史拆成固定前缀和交互组：第一条 assistant 之前的消息（系统规则、任务、项目约定、仓库地图）都是固定前缀，永不裁剪；
// 之后每个 assistant 开始一组，包含它的全部工具结果及随后的结束检查反馈。
export function splitGroups(messages: readonly Message[]): { fixed: Message[]; groups: Message[][] } {
  if (messages[0]?.role !== "system" || messages[1]?.role !== "user") {
    throw new Error("上下文必须以系统规则和原始任务开始");
  }
  let fixedCount = 2;
  while (fixedCount < messages.length && messages[fixedCount].role === "user") fixedCount++;

  const groups: Message[][] = [];
  const pendingCalls = new Set<string>();
  for (const message of messages.slice(fixedCount)) {
    if (message.role === "assistant") {
      if (pendingCalls.size) throw new Error("工具调用缺少对应结果，不能构建上下文窗口");
      groups.push([message]);
      for (const call of message.tool_calls ?? []) {
        if (pendingCalls.has(call.id)) throw new Error(`工具调用 ID 重复：${call.id}`);
        pendingCalls.add(call.id);
      }
    } else {
      const currentGroup = groups.at(-1);
      if (!currentGroup) throw new Error("历史消息缺少对应的 assistant 消息");
      if (message.role === "system") {
        throw new Error("当前滑动窗口仅支持开头的系统消息，不能裁剪中途系统指令");
      }
      if (message.role === "tool") {
        if (!message.tool_call_id || !pendingCalls.delete(message.tool_call_id)) {
          throw new Error("工具结果缺少匹配的调用，或结果重复");
        }
      } else if (pendingCalls.size) {
        throw new Error("工具结果尚未完整返回，不能插入用户反馈");
      }
      currentGroup.push(message);
    }
  }
  if (pendingCalls.size) throw new Error("工具调用缺少对应结果，不能构建上下文窗口");
  return { fixed: messages.slice(0, fixedCount), groups };
}

export interface WindowOptions {
  /** Text standing in for the dropped groups, given how many were dropped; null adds nothing. */
  summary?: (droppedGroups: number) => string | null;
}

// 返回本次请求的窗口，不修改原始历史。
// 有摘要时，它紧跟固定前缀：固定前缀保持不变，便于服务端前缀缓存。
export function buildSlidingWindow(
  messages: readonly Message[],
  tools: readonly unknown[],
  inputBudget: number,
  options: WindowOptions = {},
): { messages: Message[]; estimatedTokens: number; droppedGroups: number; summarized: boolean } {
  checkContextBudget(0, inputBudget);
  const { fixed, groups } = splitGroups(messages);

  let droppedGroups = 0;
  let summarized = false;
  const selectMessages = () => {
    const summary = droppedGroups > 0 ? options.summary?.(droppedGroups) ?? null : null;
    summarized = summary !== null;
    return [
      ...fixed,
      ...(summary !== null ? [{ role: "user" as const, content: summary }] : []),
      ...groups.slice(droppedGroups).flat(),
    ];
  };
  let selected = selectMessages();
  let estimatedTokens = estimateRequestToken(selected, tools);

  // 只从最旧的一组开始移除，至少保留最近一组完整交互。
  while (estimatedTokens > inputBudget && groups.length - droppedGroups > 1) {
    droppedGroups++;
    selected = selectMessages();
    estimatedTokens = estimateRequestToken(selected, tools);
  }

  // 固定消息、工具定义或最近一组仍然过大时，停止而不是破坏工具调用关系。
  checkContextBudget(estimatedTokens, inputBudget);
  return { messages: selected, estimatedTokens, droppedGroups, summarized };
}
