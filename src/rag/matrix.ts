import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import type { VectorIndex } from "../types.js";
import { chunkDocument, DocSearch, docsQueryPrompt, isRelevant, type DocChunk, type RetrievalCase } from "./docs.js";
import { embed, normalize, queryPrompt } from "./embedding.js";
import { Bm25Index, reciprocalRankFusion, tokenize, topK } from "./lexical.js";
import { loadIndex } from "./retriever.js";

// Retrieval ablation matrix: each variant changes one setting of the production configuration
// (1200-char chunks, heading path in the text, bigram Chinese tokens, docs query prompt, RRF k = 60)
// and runs BM25, vector and hybrid retrieval over two corpora. The ranking below mirrors
// DocSearch.search and is checked against it, so the numbers describe the code the agent runs.
//
// Labelling rules (written before the first run, see eval/retrieval/frozen.json):
// - README: the section that holds the detailed answer (title:<heading>); the summary bullets at
//   the top of the README count only where a case names their lines explicitly.
// - Think Python: the body pages of the section that answers the question, from the section's
//   first page to the next section's first page. Table of contents and glossary pages do not count.

const K = 10;
const DEPTH = Math.max(20, K * 4);

export type Method = "bm25" | "vector" | "hybrid";
type Tokenizer = (text: string) => string[];

interface Case extends RetrievalCase { style: "lexical" | "paraphrase" }

interface Corpus {
  name: string;
  chunks: DocChunk[];
  /** Text that BM25 indexes and the embedder encodes, aligned with chunks. */
  texts: string[];
  vectors: number[][];
}

interface Variant {
  name: string;
  /** Which setting differs from the baseline, for the report. */
  change: string;
  corpus: Corpus;
  cases: Case[];
  queryVectors: Map<string, number[]>;
  tokenizer: Tokenizer;
  rrfK: number;
}

/** Also index each character of multi-character Chinese runs, next to the bigrams. */
export const withChineseUnigrams: Tokenizer = (text) =>
  [...tokenize(text), ...(text.match(/[一-鿿]{2,}/g) ?? []).flatMap((run) => [...run])];

// Embeddings are the slow part (local CPU model): cache them by model and text across runs.
const CACHE = path.join(ROOT, ".rag_cache", "matrix-embeddings.json");
const MODEL = "Qwen3-Embedding-0.6B";
const key = (text: string) => createHash("sha256").update(`${MODEL}\0${text}`).digest("hex");

async function embedCached(texts: string[]) {
  const cache: Record<string, number[]> = JSON.parse(await fs.readFile(CACHE, "utf8").catch(() => "{}"));
  const missing = [...new Set(texts.filter((text) => !cache[key(text)]))];
  if (missing.length) {
    console.error(`计算 ${missing.length} 个向量（已缓存 ${texts.length - missing.length} 个）……`);
    const vectors = await embed(missing, MODEL);
    missing.forEach((text, i) => { cache[key(text)] = vectors[i]; });
    await fs.writeFile(CACHE, JSON.stringify(cache));
  }
  return texts.map((text) => normalize(cache[key(text)]));
}

export function rank(variant: Variant, query: string, method: Method): DocChunk[] {
  const { corpus } = variant;
  const lists: string[][] = [];
  if (method !== "vector") {
    const bm25 = new Bm25Index(corpus.texts, undefined, undefined, variant.tokenizer);
    lists.push(bm25.search(query, DEPTH).map(({ doc }) => corpus.chunks[doc].id));
  }
  if (method !== "bm25") {
    const q = variant.queryVectors.get(query)!;
    const dot = (i: number) => corpus.vectors[i].reduce((sum, value, j) => sum + value * q[j], 0);
    lists.push(topK(corpus.chunks.keys(), DEPTH, dot).map(({ item }) => corpus.chunks[item].id));
  }
  const byId = new Map(corpus.chunks.map((chunk) => [chunk.id, chunk]));
  return reciprocalRankFusion(lists, variant.rrfK).slice(0, K).map(({ id }) => byId.get(id)!);
}

export interface CaseResult { query: string; style: string; rank: number | null; top: string[] }

export function metrics(results: CaseResult[]) {
  const share = (n: number) => results.filter((r) => r.rank !== null && r.rank <= n).length / (results.length || 1);
  return {
    cases: results.length,
    recall_at_1: share(1),
    recall_at_5: share(5),
    recall_at_10: share(10),
    mrr_at_10: results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / (results.length || 1),
  };
}

/** Paired comparison on recall@5: cases gained and lost, plus a seeded bootstrap 95% interval of the difference. */
export function compare(baseline: CaseResult[], other: CaseResult[], samples = 2000, seed = 7) {
  const hit = (r: CaseResult) => (r.rank !== null && r.rank <= 5 ? 1 : 0);
  const diffs = baseline.map((b, i) => hit(other[i]) - hit(b));
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means = Array.from({ length: samples }, () => {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(random() * diffs.length)];
    return sum / diffs.length;
  }).sort((a, b) => a - b);
  return {
    gained: baseline.filter((_, i) => diffs[i] > 0).map((b) => b.query),
    lost: baseline.filter((_, i) => diffs[i] < 0).map((b) => b.query),
    delta_recall_at_5: diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1),
    ci95: [means[Math.floor(samples * 0.025)], means[Math.floor(samples * 0.975)]],
  };
}

function evaluate(variant: Variant, method: Method): CaseResult[] {
  return variant.cases.map((item) => {
    const top = rank(variant, item.query, method);
    const position = top.findIndex((chunk) => item.relevant.some((wanted) => isRelevant(chunk, wanted))) + 1;
    return { query: item.query, style: item.style, rank: position || null, top: top.slice(0, 5).map((chunk) => chunk.location) };
  });
}

async function readmeCorpus(text: string, maxChars: number, withTitle: boolean): Promise<Corpus> {
  const chunks = chunkDocument("README.md", text, maxChars);
  const texts = chunks.map((chunk) => (withTitle ? `${chunk.title}\n${chunk.text}` : chunk.text));
  return { name: `README（${maxChars} 字符${withTitle ? "" : "，不含标题"}）`, chunks, texts, vectors: await embedCached(texts) };
}

function pdfCorpus(index: VectorIndex, file: string): Corpus {
  const name = path.basename(file);
  // Same chunk ids and text as DocSearch.build gives an index; the vectors were built from the content alone.
  const chunks = index.chunks.map((chunk) => ({ id: `${name}#${chunk.chunk_id}`, source: chunk.source, location: `${chunk.source} 第 ${chunk.page} 页`, title: "", text: chunk.content }));
  return { name: "Think Python（索引自带向量）", chunks, texts: chunks.map((chunk) => `${chunk.title}\n${chunk.text}`), vectors: index.chunks.map((chunk) => chunk.embedding) };
}

/** The matrix's baseline ranking must equal what search_docs returns for the same chunks. */
async function checkParity(variant: Variant, method: Method, index: VectorIndex | null) {
  const chunks = variant.corpus.chunks.map((chunk, i) => (index ? { ...chunk, embedding: variant.corpus.vectors[i] } : chunk));
  const search = new DocSearch(chunks, index, async ([prompt]) => [variant.queryVectors.get(prompt.slice(prompt.indexOf("Query:") + 6))!]);
  for (const item of variant.cases) {
    const expected = (await search.search(item.query, K)).results.map((r) => r.id);
    const actual = rank(variant, item.query, method).map((chunk) => chunk.id);
    if (expected.join() !== actual.join()) throw new Error(`矩阵排序与 search_docs 不一致：${variant.name} / ${item.query}`);
  }
}

export async function runMatrix(options: { readmeCases: string; pdfCases: string; pdfIndex: string; out: string }) {
  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  const readmeCases: Case[] = JSON.parse(await fs.readFile(options.readmeCases, "utf8"));
  const pdfCases: Case[] = JSON.parse(await fs.readFile(options.pdfCases, "utf8"));
  const leaked = readmeCases.filter((item) => readme.includes(item.query)).map((item) => item.query);

  const docsQueries = await embedCached([...readmeCases, ...pdfCases].map((item) => docsQueryPrompt(item.query)));
  const bookQueries = await embedCached(pdfCases.map((item) => queryPrompt(item.query)));
  const vectorsFor = (cases: Case[], vectors: number[][], offset = 0) =>
    new Map(cases.map((item, i) => [item.query, vectors[offset + i]]));
  const readmeVectors = vectorsFor(readmeCases, docsQueries);

  const base = { tokenizer: tokenize, rrfK: 60 };
  const readmeBase: Variant = { name: "README 基线", change: "—", corpus: await readmeCorpus(readme, 1200, true), cases: readmeCases, queryVectors: readmeVectors, ...base };
  const index = await loadIndex(options.pdfIndex);
  const pdfBase: Variant = { name: "Think Python 基线", change: "—", corpus: pdfCorpus(index, options.pdfIndex), cases: pdfCases, queryVectors: vectorsFor(pdfCases, docsQueries, readmeCases.length), ...base };

  const variants: { variant: Variant; methods: Method[] }[] = [
    { variant: readmeBase, methods: ["bm25", "vector", "hybrid"] },
    { variant: { ...readmeBase, name: "README 600 字符", change: "切分 1200 → 600", corpus: await readmeCorpus(readme, 600, true) }, methods: ["bm25", "vector", "hybrid"] },
    { variant: { ...readmeBase, name: "README 2400 字符", change: "切分 1200 → 2400", corpus: await readmeCorpus(readme, 2400, true) }, methods: ["bm25", "vector", "hybrid"] },
    { variant: { ...readmeBase, name: "README 不含标题", change: "检索文本去掉标题路径", corpus: await readmeCorpus(readme, 1200, false) }, methods: ["bm25", "vector", "hybrid"] },
    { variant: { ...readmeBase, name: "README 中文单字", change: "中文 bigram → bigram + 单字", tokenizer: withChineseUnigrams }, methods: ["bm25", "hybrid"] },
    { variant: { ...readmeBase, name: "README RRF k=10", change: "RRF k 60 → 10", rrfK: 10 }, methods: ["hybrid"] },
    { variant: pdfBase, methods: ["bm25", "vector", "hybrid"] },
    { variant: { ...pdfBase, name: "Think Python 教材提示词", change: "查询提示词：通用文档 → Python 教材", queryVectors: vectorsFor(pdfCases, bookQueries) }, methods: ["vector", "hybrid"] },
    { variant: { ...pdfBase, name: "Think Python RRF k=10", change: "RRF k 60 → 10", rrfK: 10 }, methods: ["hybrid"] },
  ];

  // README chunks carry no vectors in search_docs today, so its parity check covers BM25 only.
  await checkParity(readmeBase, "bm25", null);
  await checkParity(pdfBase, "hybrid", index);

  const rows = variants.flatMap(({ variant, methods }) => methods.map((method) => {
    const results = evaluate(variant, method);
    const chars = variant.corpus.chunks.map((chunk) => chunk.text.length);
    return {
      variant: variant.name, change: variant.change, method, chunks: chars.length,
      average_chunk_chars: Math.round(chars.reduce((a, b) => a + b, 0) / chars.length),
      ...metrics(results),
      by_style: Object.fromEntries(["lexical", "paraphrase"].map((style) => [style, metrics(results.filter((r) => r.style === style))])),
      per_case: results,
    };
  }));
  const find = (variant: string, method: Method) => rows.find((row) => row.variant === variant && row.method === method)!.per_case;
  const comparisons = Object.fromEntries(
    [readmeBase.name, pdfBase.name].flatMap((name) => (["vector", "hybrid"] as const).map((method) =>
      [`${name}：${method} 相对 bm25`, compare(find(name, "bm25"), find(name, method))])),
  );

  const frozen = JSON.parse(await fs.readFile(path.join(path.dirname(options.readmeCases), "frozen.json"), "utf8").catch(() => "null"));
  const report = { generated_at: new Date().toISOString(), model: MODEL, k: K, depth: DEPTH, frozen, leaked_queries: leaked, rows, comparisons };
  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.writeFile(options.out, JSON.stringify(report, null, 2) + "\n");
  return report;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function renderMatrix(report: Awaited<ReturnType<typeof runMatrix>>) {
  const lines = [
    `检索对照矩阵（${report.generated_at}，${report.model}，每路取前 ${report.depth}，评估前 ${report.k}）`,
    "",
    "| 配置 | 改动 | 方法 | 片段数 | 平均字符 | recall@1 | recall@5 | MRR@10 | 字面 r@5 | 改写 r@5 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...report.rows.map((row) => `| ${row.variant} | ${row.change} | ${row.method} | ${row.chunks} | ${row.average_chunk_chars} | ${pct(row.recall_at_1)} | ${pct(row.recall_at_5)} | ${row.mrr_at_10.toFixed(3)} | ${pct(row.by_style.lexical.recall_at_5)} (${row.by_style.lexical.cases}) | ${pct(row.by_style.paraphrase.recall_at_5)} (${row.by_style.paraphrase.cases}) |`),
    "",
    "配对比较（recall@5，基线为同一语料上的 bm25）：",
    ...Object.entries(report.comparisons).map(([name, c]) =>
      `- ${name}：${c.delta_recall_at_5 >= 0 ? "+" : ""}${pct(c.delta_recall_at_5)}，95% 区间 [${pct(c.ci95[0])}, ${pct(c.ci95[1])}]，新增命中 ${c.gained.length}，丢失 ${c.lost.length}`),
    "",
    report.leaked_queries.length ? `警告：${report.leaked_queries.length} 个问题原样出现在 README 中：${report.leaked_queries.join("；")}` : "泄漏检查：没有问题原样出现在 README 中。",
  ];
  return lines.join("\n");
}
