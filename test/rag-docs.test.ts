import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Bm25Index, reciprocalRankFusion, tokenize, topK } from "../src/rag/lexical.ts";
import { chunkDocument, DocSearch, evaluateRetrieval } from "../src/rag/docs.ts";
import { executeTool } from "../src/tools.ts";
import { MCPClient } from "../src/mcp/client.ts";
import { runAgent } from "../src/agent.ts";
import type { Message } from "../src/types.ts";

async function temp(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-rag-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function project(t: any, files: Record<string, string>) {
  const dir = await temp(t);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

test("tokenize splits code identifiers, drops English stopwords and uses Chinese bigrams", () => {
  assert.deepEqual(tokenize("The parseRetryAfter helper"), ["parseretryafter", "parse", "retry", "after", "helper"]);
  assert.deepEqual(tokenize("max_retries HTTPServer v2"), ["max_retries", "max", "retries", "httpserver", "http", "server", "v2"]);
  assert.deepEqual(tokenize("上下文超限，重试"), ["上下", "下文", "文超", "超限", "重试"]);
  assert.deepEqual(tokenize("用 a 写"), ["用", "写"]);
});

test("topK matches a full sort and keeps the k largest in descending order", () => {
  for (let round = 0; round < 50; round++) {
    const values = Array.from({ length: 1 + Math.floor(Math.random() * 60) }, () => Math.floor(Math.random() * 100));
    const k = 1 + Math.floor(Math.random() * 10);
    assert.deepEqual(topK(values, k, v => v).map(e => e.score), [...values].sort((a, b) => b - a).slice(0, k));
  }
  assert.throws(() => topK([1], 0, v => v), /k 必须是正整数/);
});

test("BM25: rare terms weigh more, term frequency saturates, shorter documents win ties", () => {
  const index = new Bm25Index([
    "retry retry retry retry retry retry retry retry retry retry",
    "retry jitter",
    "retry jitter backoff policy for the model client with many other words here",
    "unrelated text",
  ]);
  assert.ok(index.idf("jitter") > index.idf("retry"), "出现在更少文档中的词 idf 更高");
  const hits = index.search("retry jitter", 10);
  assert.deepEqual(hits.map(h => h.doc), [1, 2, 0], "只返回包含查询词的文档");
  const tf10 = index.search("retry", 4).find(h => h.doc === 0)!.score;
  const tf1 = index.search("retry", 4).find(h => h.doc === 1)!.score;
  assert.ok(tf10 < tf1 * 3, "词频饱和：出现 10 次远不到 10 倍分数");
});

test("reciprocal rank fusion rewards items ranked well in several lists", () => {
  const fused = reciprocalRankFusion([["a", "b", "c"], ["c", "a", "d"]]);
  assert.deepEqual(fused.map(f => f.id), ["a", "c", "b", "d"]);
  assert.equal(fused[0].score, 1 / 61 + 1 / 62);
});

test("chunkDocument keeps heading paths and line ranges, packs paragraphs and ignores # inside code fences", () => {
  const doc = [
    "# Guide", "", "Intro line.", "", "## Retry", "", "Use backoff.", "", "```bash", "# not a heading", "", "npm test", "```", "",
    "## Long", "", ...Array.from({ length: 30 }, (_, i) => `line ${i} ${"x".repeat(50)}`),
  ].join("\n");
  const chunks = chunkDocument("docs/guide.md", doc, 600);
  assert.deepEqual(chunks.slice(0, 2).map(c => [c.location, c.title]), [["docs/guide.md:1-3", "Guide"], ["docs/guide.md:5-13", "Guide > Retry"]]);
  assert.match(chunks[1].text, /# not a heading\n\nnpm test/, "代码块整体保留，空行不拆");
  const long = chunks.filter(c => c.title === "Guide > Long");
  assert.ok(long.length > 1, "超长段落按行切分");
  assert.ok(long.every(c => c.text.length <= 600));
  assert.equal(long[0].location.split(":")[1].split("-")[0], "15");
});

async function vectorIndex(dir: string) {
  // Two "manual pages": only the second is about rate limits, but it never says "429".
  const file = path.join(dir, "manual.index.json");
  await fs.writeFile(file, JSON.stringify({ model: "test-embed", dimension: 2, chunks: [
    { source: "manual.pdf", page: 1, chunk_id: "p1", start_char: 0, end_char: 10, content: "Installation steps for the CLI.", embedding: [1, 0] },
    { source: "manual.pdf", page: 7, chunk_id: "p7", start_char: 0, end_char: 10, content: "When the service is busy, wait before sending again.", embedding: [0, 1] },
  ] }));
  return file;
}

test("hybrid search: vectors find what words miss, fused with BM25; embedding failures fall back to BM25", async t => {
  const dir = await project(t, { "README.md": "# Errors\n\nHTTP 429 means too many requests.\n" });
  const indexPath = await vectorIndex(dir);
  const embedder = async () => [[0, 3]]; // close to page 7, not normalized on purpose
  const hybrid = await DocSearch.build(dir, { indexPath, embedder });
  const result = await hybrid.search("429 rate limit", 3);
  assert.equal(result.mode, "hybrid");
  assert.equal(result.total_chunks, 3);
  // Each is first in one list (BM25 vs vectors), so they tie in RRF; the unrelated page 1 comes after both.
  assert.deepEqual(result.results.slice(0, 2).map(r => r.location).sort(), ["README.md:1-3", "manual.pdf 第 7 页"]);
  assert.equal(result.results[0].score, result.results[1].score);
  assert.equal(result.results[2].location, "manual.pdf 第 1 页");

  const broken = await DocSearch.build(dir, { indexPath, embedder: async () => { throw new Error("no model"); } });
  const fallback = await broken.search("429 rate limit", 3);
  assert.equal(fallback.mode, "bm25");
  assert.match(fallback.note!, /只用了 BM25.*no model/);
  const wrongDim = await DocSearch.build(dir, { indexPath, embedder: async () => [[1, 0, 0]] });
  assert.match((await wrongDim.search("x", 1)).note!, /维度不一致/);
  await assert.rejects(hybrid.search("  ", 1), /不能为空/);
  await assert.rejects(hybrid.search("x", 11), /1–10/);
});

test("retrieval evaluation reports recall@k and MRR", async t => {
  const dir = await project(t, {
    "docs/retry.md": "# Retry\n\nBackoff with jitter after 429.\n",
    "docs/sandbox.md": "# Sandbox\n\nDocker without network.\n",
    "README.md": "# Project\n\nOverview of retry and sandbox.\n",
  });
  const search = await DocSearch.build(dir);
  const report = await evaluateRetrieval(search, [
    { query: "jitter backoff", relevant: ["docs/retry.md"] },
    { query: "docker network", relevant: ["docs/sandbox.md"] },
    { query: "kubernetes", relevant: ["docs/k8s.md"] },
    { query: "jitter", relevant: ["title:Retry"] },
  ], 2);
  assert.equal(report.recall_at_k, 3 / 4);
  assert.equal(report.mrr, (1 + 1 + 1) / 4);
  assert.equal(report.per_case[2].rank, null);
});

test("search_docs works through executeTool and the MCP server, and sees edited docs", async t => {
  const dir = await project(t, { "README.md": "# Setup\n\nRun npm ci first.\n" });
  const first = await executeTool(dir, "search_docs", { query: "npm ci" }) as any;
  assert.equal(first.results[0].location, "README.md:1-3");
  await fs.writeFile(path.join(dir, "README.md"), "# Setup\n\nRun pnpm install first.\n");
  const second = await executeTool(dir, "search_docs", { query: "pnpm install" }) as any;
  assert.match(second.results[0].text, /pnpm/, "文档变化后索引重建");

  const client = new MCPClient(new URL("../src/mcp/server.ts", import.meta.url), dir);
  try {
    assert.ok((await client.listTools()).some(tool => tool.name === "search_docs"));
    assert.equal(((await client.callTool("search_docs", { query: "pnpm", top_k: 1 })) as any).results.length, 1);
  } finally {
    await client.close();
  }
});

test("search_docs is offered to the model only when there are docs and the feature is on", async t => {
  const previous = { ...process.env };
  Object.assign(process.env, { MODEL_PROVIDER: "RAG_TEST", RAG_TEST_API_KEY: "k", RAG_TEST_BASE_URL: "https://example.invalid/v1", RAG_TEST_MODEL: "m" });
  t.after(() => { for (const key of ["MODEL_PROVIDER", "RAG_TEST_API_KEY", "RAG_TEST_BASE_URL", "RAG_TEST_MODEL"]) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; });
  const offered = async (files: Record<string, string>, features = {}) => {
    const base = await temp(t);
    const source = path.join(base, "source");
    for (const [name, content] of Object.entries({ "ok.test.js": 'require("node:test")("ok", () => {});', ...files }))
      await fs.mkdir(source, { recursive: true }).then(() => fs.writeFile(path.join(source, name), content));
    let tools: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      tools = JSON.parse(options.body as string).tools.map((tool: any) => tool.function.name);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "完成" } as Message }] }));
    });
    const report = await runAgent({ base, source, mock: false, maxRounds: 1, features: { repoMap: false, ...features } });
    return { tools, offered: report.statistics.docs.offered };
  };
  assert.deepEqual(await offered({}).then(r => [r.tools.includes("search_docs"), r.offered]), [false, false]);
  assert.deepEqual(await offered({ "README.md": "# Doc\n" }).then(r => [r.tools.includes("search_docs"), r.offered]), [true, true]);
  assert.equal((await offered({ "README.md": "# Doc\n" }, { docs: false })).tools.includes("search_docs"), false);
});
