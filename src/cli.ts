import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { runAgent } from "./agent.js";
import { parseFeatures } from "./features.js";
import type { TestConfig } from "./tools.js";
import { runRepairDemo } from "./runner.js";
import { chunkPages } from "./rag/chunker.js";
import { embed, queryPrompt } from "./rag/embedding.js";
import { loadIndex, search } from "./rag/retriever.js";
import type { Chunk, VectorIndex } from "./types.js";
function parseStrategy(value?: string) {
  if (value === undefined || value === "react" || value === "plan-execute") return value;
  throw new Error("--strategy 只能是 react 或 plan-execute");
}
function parsePlanLimits(values: { "step-rounds"?: string; "max-replans"?: string }) {
  const limits: { stepRounds?: number; maxReplans?: number } = {};
  const read = (name: string, value: string | undefined, min: number) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} 必须是不小于 ${min} 的整数`);
    return n;
  };
  limits.stepRounds = read("step-rounds", values["step-rounds"], 1);
  limits.maxReplans = read("max-replans", values["max-replans"], 0);
  return Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined));
}
function parseWorkspace(value?: string) {
  if (value === undefined || value === "copy" || value === "git") return value;
  throw new Error("--workspace 只能是 copy 或 git");
}
function parseTestConfig(values: { "test-command"?: string; "test-timeout"?: string; sandbox?: string; image?: string; "sandbox-network"?: string; preserve?: string[] }): TestConfig {
  const config: TestConfig = {};
  if (values["test-command"]) config.command = values["test-command"];
  if (values["test-timeout"]) {
    config.timeoutMs = Number(values["test-timeout"]);
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("--test-timeout 必须是正整数（毫秒）");
  }
  if (values.sandbox !== undefined) {
    if (values.sandbox !== "docker") throw new Error("--sandbox 目前只支持 docker");
    if (!values.image) throw new Error("--sandbox docker 需要 --image");
    if (values["sandbox-network"] !== undefined && !["on", "off"].includes(values["sandbox-network"])) throw new Error("--sandbox-network 只能是 on 或 off");
    config.sandbox = { image: values.image, network: values["sandbox-network"] === "on", preserve: values.preserve };
  }
  return config;
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { replay: { type: "string" }, source: { type: "string" }, task: { type: "string" }, mock: { type: "boolean" }, apply: { type: "boolean" }, mcp: { type: "boolean" }, "max-rounds": { type: "string" }, context: { type: "string" }, truncate: { type: "string" }, summary: { type: "string" }, "repo-map": { type: "string" }, "project-notes": { type: "string" }, workspace: { type: "string" }, "setup-command": { type: "string" }, "test-command": { type: "string" }, "test-timeout": { type: "string" }, sandbox: { type: "string" }, image: { type: "string" }, "sandbox-network": { type: "string" }, preserve: { type: "string", multiple: true }, "pro-dir": { type: "string" }, stream: { type: "boolean" }, "loop-guard": { type: "string" }, docs: { type: "string" }, "docs-index": { type: "string" }, strategy: { type: "string" }, "step-rounds": { type: "string" }, "max-replans": { type: "string" }, index: { type: "string" }, "top-k": { type: "string" }, "min-chars": { type: "string" } } });
  const [command, action, argument] = positionals;
  if (command === "agent") {
    const report = await runAgent({ replay: values.replay, source: values.source ? path.resolve(values.source) : undefined, task: values.task, mock: values.mock, apply: values.apply, mcp: values.mcp, maxRounds: values["max-rounds"] ? Number(values["max-rounds"]) : undefined, features: parseFeatures(values),
      workspace: parseWorkspace(values.workspace), setupCommand: values["setup-command"], testConfig: parseTestConfig(values), stream: values.stream, docs: { indexPath: values["docs-index"] },
      strategy: parseStrategy(values.strategy), planLimits: parsePlanLimits(values) });
    if (report.status !== "passed") process.exitCode = 1;
  } else if (command === "swe") {
    if (!action) throw new Error("用法：npm run swe -- <instance_id> --pro-dir <SWE-bench_Pro-os 目录>（需要 Docker）");
    const { runSweTask } = await import("./bench/swe-pro.js");
    const result = await runSweTask(values["pro-dir"] ?? path.join(ROOT, "..", "SWE-bench_Pro-os"), action, {
      mcp: values.mcp, maxRounds: values["max-rounds"] ? Number(values["max-rounds"]) : undefined, features: parseFeatures(values), stream: values.stream });
    if (!result.resolved) process.exitCode = 1;
  } else if (command === "runner") {
    if ((await runRepairDemo()).final_status !== "passed") process.exitCode = 1;
  } else if (command === "rag") {
    const cache = path.join(ROOT, ".rag_cache"); await fs.mkdir(cache, { recursive: true });
    if (action === "chunk") {
      if (!argument) throw new Error("用法：npm run rag -- chunk <pdf路径>");
      const { loadPdf } = await import("./rag/pdf-loader.js");
      const pages = await loadPdf(argument), chunks = chunkPages(pages);
      const output = path.join(cache, path.parse(argument).name + ".chunks.json");
      await fs.writeFile(output, JSON.stringify(chunks, null, 2)); console.log({ pages: pages.length, chunks: chunks.length, output });
    } else if (action === "embed") {
      if (!argument) throw new Error("用法：npm run rag -- embed <chunks.json>");
      const chunks: Chunk[] = JSON.parse(await fs.readFile(argument, "utf8"));
      if (!chunks.length) throw new Error("没有片段");
      const vectors = await embed(chunks.map(c => c.content));
      const index: VectorIndex = { model: process.env.EMBEDDING_MODEL ?? "Qwen3-Embedding-0.6B", dimension: vectors[0].length, normalized: true, chunks: chunks.map((c, i) => ({ ...c, embedding: vectors[i] })) };
      const output = path.join(cache, path.basename(argument).replace(/\.chunks\.json$/, "") + ".index.json");
      await fs.writeFile(output, JSON.stringify(index)); console.log(output);
    } else if (action === "search") {
      if (!argument) throw new Error("用法：npm run rag -- search '问题' [--index 路径]");
      const index = await loadIndex(values.index ?? path.join(cache, "thinkpython2.index.json"));
      if (process.env.EMBEDDING_MODEL && process.env.EMBEDDING_MODEL !== index.model) throw new Error("查询模型必须与索引模型一致");
      const [vector] = await embed([queryPrompt(argument)], index.model);
      console.log(JSON.stringify(search(index, vector, Number(values["top-k"] ?? 3), Number(values["min-chars"] ?? 0)), null, 2));
    } else if (action === "search-docs") {
      if (!argument) throw new Error("用法：npm run rag -- search-docs '问题' [--source 项目目录] [--docs-index 索引] [--top-k 5]");
      const { DocSearch } = await import("./rag/docs.js");
      const docs = await DocSearch.build(path.resolve(values.source ?? path.join(ROOT, ".")), { indexPath: values["docs-index"] });
      console.log(JSON.stringify(await docs.search(argument, Number(values["top-k"] ?? 5)), null, 2));
    } else if (action === "eval-docs") {
      if (!argument) throw new Error("用法：npm run rag -- eval-docs <cases.json> [--source 项目目录] [--docs-index 索引] [--top-k 5]");
      const { DocSearch, evaluateRetrieval } = await import("./rag/docs.js");
      const docs = await DocSearch.build(path.resolve(values.source ?? path.join(ROOT, ".")), { indexPath: values["docs-index"] });
      const cases = JSON.parse(await fs.readFile(argument, "utf8"));
      console.log(JSON.stringify(await evaluateRetrieval(docs, cases, Number(values["top-k"] ?? 5)), null, 2));
    } else if (action === "eval-matrix") {
      const { runMatrix, renderMatrix } = await import("./rag/matrix.js");
      const stamp = new Date().toISOString().slice(0, 10);
      const out = path.join(ROOT, "eval", "results", `retrieval-${stamp}.json`);
      const report = await runMatrix({ readmeCases: path.join(ROOT, "eval/retrieval/readme.json"), pdfCases: path.join(ROOT, "eval/retrieval/thinkpython.json"),
        pdfIndex: values["docs-index"] ?? path.join(cache, "thinkpython2.index.json"), out });
      // No .md next to the JSON: search_docs indexes markdown, and results quoting the questions would leak into the corpus.
      console.log(`${renderMatrix(report)}\n\n明细：${out}`);
    } else if (action === "import") {
      if (!argument) throw new Error("用法：npm run rag -- import <Python index.json>");
      const index = await loadIndex(argument);
      const output = path.join(cache, path.basename(argument));
      await fs.writeFile(output, JSON.stringify(index)); console.log(`已导入 ${index.chunks.length} 个向量：${output}`);
    } else throw new Error("rag 子命令：chunk / embed / search / search-docs / eval-docs / eval-matrix / import");
  } else throw new Error("命令：agent / runner / rag / swe");
}
main().catch(e => { console.error(String(e)); process.exitCode = 1; });
