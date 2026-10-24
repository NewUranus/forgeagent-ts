export type TaskStatus =
  | "running"
  | "passed"
  | "failed"
  | "timeout"
  | "error"
  | "limit_reached";
export interface TestResult {
  exit_code: number | null;
  time_out: boolean;
  stdout: string;
  stderr: string;
  // "partial" when only selected tests ran; such runs never count as final verification.
  scope?: "full" | "partial";
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface Page {
  source: string;
  page: number;
  content: string;
}
export interface Chunk extends Page {
  chunk_id: string;
  start_char: number;
  end_char: number;
}
export interface VectorChunk extends Chunk {
  embedding: number[];
}
export interface VectorIndex {
  model: string;
  dimension: number;
  normalized: boolean;
  chunks: VectorChunk[];
}

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
}

export interface Plan {
  steps: PlanStep[];
  updated_at: string;
}
