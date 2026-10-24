import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, tools, type ToolContext } from "../tools.js";
export const VERSION = "2026-07-28";
const info = { name: "forgeagent-ts-workspace", version: "0.1.0" };
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
export async function handle(message: unknown, root: string, context: ToolContext = {}): Promise<unknown | undefined> {
  const error = (id: unknown, code: number, text: string, data?: unknown) => ({ jsonrpc: "2.0", ...(id == null ? {} : { id }), error: { code, message: text, ...(data ? { data } : {}) } });
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return error(null, -32600, "Invalid Request");
  if (!("id" in message)) return undefined;
  const id = message.id;
  if (!(typeof id === "string" || Number.isInteger(id))) return error(null, -32600, "Invalid id");
  const params = message.params, meta = params?._meta;
  if (!object(params) || !object(meta) || typeof meta["io.modelcontextprotocol/protocolVersion"] !== "string" || !object(meta["io.modelcontextprotocol/clientCapabilities"])) return error(id, -32602, "Missing required metadata");
  const version = meta["io.modelcontextprotocol/protocolVersion"];
  if (version !== VERSION) return error(id, -32022, "Unsupported protocol version", { supported: [VERSION], requested: version });
  const success = (result: object) => ({ jsonrpc: "2.0", id, result: { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": info } } });
  if (message.method === "server/discover") return success({ supportedVersions: [VERSION], capabilities: { tools: {} } });
  if (message.method === "ping") return success({});
  if (message.method === "tools/list") return success({ tools });
  if (message.method !== "tools/call") return error(id, -32601, "Method not found");
  if (!tools.some(t => t.name === params.name) || !object(params.arguments ?? {})) return error(id, -32602, "Unknown tool or invalid arguments");
  try {
    const data = await executeTool(root, params.name, params.arguments ?? {}, context);
    return success({ content: [{ type: "text", text: JSON.stringify(data) }], isError: false });
  } catch (e) { return success({ content: [{ type: "text", text: String(e) }], isError: true }); }
}
async function main() {
  const flag = process.argv.indexOf("--project-dir");
  if (flag < 0 || !process.argv[flag + 1]) throw new Error("需要 --project-dir");
  const root = await fs.realpath(process.argv[flag + 1]);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("工作目录不存在");
  // The agent passes its tool configuration (test command, sandbox, docs index) explicitly, never via shared files.
  const contextFlag = process.argv.indexOf("--tool-context");
  const context: ToolContext = contextFlag < 0 ? {} : JSON.parse(process.argv[contextFlag + 1]);
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }) + "\n"); continue; }
    const response = await handle(message, root, context);
    if (response !== undefined) process.stdout.write(JSON.stringify(response) + "\n");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(String(e)); process.exitCode = 1; });
