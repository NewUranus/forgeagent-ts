import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "../types.js";
import type { TestConfig } from "../tools.js";
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export class MCPClient {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private exited: Promise<void>;
  constructor(server: URL, root: string, private timeout = 40000, testConfig?: TestConfig) {
    const file = fileURLToPath(server);
    const configArgs = testConfig ? ["--test-config", JSON.stringify(testConfig)] : [];
    this.child = spawn(process.execPath, [...(file.endsWith(".ts") ? ["--import", "tsx"] : []), file, "--project-dir", root, ...configArgs], { stdio: "pipe" });
    this.child.stderr.on("data", data => process.stderr.write(data));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      try {
        const response = JSON.parse(line);
        if (response.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC response");
        if (!("id" in response)) return; // No subscriptions requested; ignore notifications.
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(JSON.stringify(response.error)));
        else if (response.result?.resultType !== "complete") pending.reject(new Error("Unsupported MCP result"));
        else pending.resolve(response.result);
      } catch (e) { this.fail(new Error(`MCP 无效响应：${String(e)}`)); }
    });
    this.child.on("error", e => this.fail(e));
    this.child.stdin.on("error", e => this.fail(e));
    this.exited = new Promise(resolve => this.child.on("close", () => { this.closed = true; this.fail(new Error("MCP Server 已退出")); resolve(); }));
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("MCP 连接已关闭"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP 请求超时：${method}`)); void this.close(); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "forgeagent-ts", version: "0.1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }) + "\n", error => { if (error) this.fail(error); });
    });
  }
  async listTools(): Promise<ToolDefinition[]> { return (await this.request("tools/list")).tools; }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
    if (result.isError) throw new Error(text || "MCP 工具失败");
    return JSON.parse(text);
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.exited; clearTimeout(timer);
  }
}
