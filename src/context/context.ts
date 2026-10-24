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

// 返回本次请求的窗口，不修改原始历史。适用于当前 Agent 的 system + user 开头结构。
export function buildSlidingWindow(
  messages: readonly Message[],
  tools: readonly unknown[],
  inputBudget: number,
): { messages: Message[]; estimatedTokens: number; droppedGroups: number } {
  checkContextBudget(0, inputBudget);
  if (messages[0]?.role !== "system" || messages[1]?.role !== "user") {
    throw new Error("上下文必须以系统规则和原始任务开始");
  }

  const fixedMessages = messages.slice(0, 2);
  const groups: Message[][] = [];
  const pendingCalls = new Set<string>();

  // 每个 assistant 开始一组；该组包含全部工具结果及可能的结束检查反馈。
  for (const message of messages.slice(2)) {
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

  let droppedGroups = 0;
  const selectMessages = () => [
    ...fixedMessages,
    ...groups.slice(droppedGroups).flat(),
  ];
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
  return { messages: selected, estimatedTokens, droppedGroups };
}
