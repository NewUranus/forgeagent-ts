import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { QdrantClient } from "@qdrant/js-client-rest";
import { ExactStore } from "../src/rag/vector-store.ts";
import { pointId, QDRANT_URL, QdrantStore } from "../src/rag/qdrant-store.ts";
import { DocSearch } from "../src/rag/docs.ts";
import { normalize } from "../src/rag/embedding.ts";

function randomVectors(n: number, dimension: number, seed = 1) {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, vector: normalize(Array.from({ length: dimension }, random)) }));
}

test("ExactStore ranks by dot product exactly like a full scan, with upsert, delete and dimension checks", async () => {
  const points = randomVectors(200, 16);
  const store = new ExactStore(16, points.slice(0, 150));
  await store.upsert(points.slice(150));
  assert.equal(await store.count(), 200);
  const query = randomVectors(1, 16, 99)[0].vector;
  const dot = (v: number[]) => v.reduce((sum, value, i) => sum + value * query[i], 0);
  const expected = points.map((p) => ({ id: p.id, score: dot(p.vector) })).sort((a, b) => b.score - a.score).slice(0, 10);
  assert.deepEqual(await store.search(query, 10), expected);

  // Overwriting an id keeps the count; deleting moves the last row into the hole and still ranks right.
  await store.upsert([{ id: "p0", vector: query }]);
  assert.equal(await store.count(), 200);
  assert.equal((await store.search(query, 1))[0].id, "p0");
  await store.delete(["p0", "p5", "missing"]);
  assert.equal(await store.count(), 198);
  const left = points.filter((p) => p.id !== "p0" && p.id !== "p5");
  assert.deepEqual((await store.search(query, 5)).map((h) => h.id), left.map((p) => ({ id: p.id, score: dot(p.vector) })).sort((a, b) => b.score - a.score).slice(0, 5).map((h) => h.id));
  await assert.rejects(store.search([1, 0], 1), /维度/);
  assert.throws(() => new ExactStore(2, [{ id: "x", vector: [1, 0, 0] }]), /维度/);
});

test("Qdrant point ids are stable RFC 4122 UUIDs", () => {
  assert.equal(pointId("a#1"), pointId("a#1"));
  assert.notEqual(pointId("a#1"), pointId("a#2"));
  assert.match(pointId("a#1"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// Integration tests against a running server (`npm run qdrant`); skipped when none answers.
const qdrantUp = await fetch(QDRANT_URL, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false);
const skip = qdrantUp ? false : `Qdrant 未运行（${QDRANT_URL}）`;

async function dropAfter(t: any, prefix: string) {
  t.after(async () => {
    const client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
    for (const { name } of (await client.getCollections()).collections) if (name.startsWith(prefix)) await client.deleteCollection(name);
  });
}

test("QdrantStore: exact search matches ExactStore; HNSW is built when forced; sync, delete and count", { skip }, async (t) => {
  const collection = `test_store_${process.pid}`;
  await dropAfter(t, collection);
  const points = randomVectors(300, 32, 3);
  const store = await QdrantStore.open({ collection, dimension: 32, recreate: true, forceIndex: true });
  await store.upsert(points);
  const { indexed } = await store.waitIndexed(60_000);
  assert.equal(indexed, 300);
  const exact = new ExactStore(32, points);
  for (const { vector } of randomVectors(5, 32, 42)) {
    const truth = (await exact.search(vector, 10)).map((h) => h.id);
    assert.deepEqual((await store.search(vector, 10, { exact: true })).map((h) => h.id), truth);
    // 300 points with m = 16: a generous ef finds the true neighbours.
    assert.deepEqual((await store.search(vector, 10, { ef: 128 })).map((h) => h.id), truth);
  }
  // sync reuses a collection that already holds the same number of points, and rebuilds otherwise.
  assert.equal((await QdrantStore.sync({ collection, dimension: 32 }, points)).uploaded, 0);
  assert.equal((await QdrantStore.sync({ collection, dimension: 32 }, points.slice(0, 250))).uploaded, 250);
  await (await QdrantStore.open({ collection, dimension: 32 })).upsert(points.slice(250));
  await store.delete(["p0", "p1"]);
  assert.equal(await store.count(), 298);
  await assert.rejects(QdrantStore.open({ collection, dimension: 8 }), /维度/);
});

test("search_docs gives the same hybrid ranking with vectors in Qdrant as in memory", { skip }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-qdrant-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "README.md"), "# Errors\n\nHTTP 429 means too many requests.\n");
  const indexPath = path.join(dir, `qdrant_${process.pid}.index.json`);
  const chunks = randomVectors(40, 8, 5).map((p, i) => ({ source: "manual.pdf", page: i + 1, chunk_id: `c${i}`, start_char: 0, end_char: 1, content: `page ${i} text`, embedding: p.vector }));
  await fs.writeFile(indexPath, JSON.stringify({ model: "test-embed", dimension: 8, chunks }));
  await dropAfter(t, `docs_qdrant_${process.pid}`);
  const embedder = async () => [randomVectors(1, 8, 77)[0].vector];

  const memory = await DocSearch.build(dir, { indexPath, embedder });
  const qdrant = await DocSearch.build(dir, { indexPath, embedder, vectorStore: "qdrant" });
  const [a, b] = [await memory.search("429 page", 10), await qdrant.search("429 page", 10)];
  assert.equal(a.vector_store, "exact");
  assert.equal(b.vector_store, "qdrant");
  assert.deepEqual(b.results.map((r) => r.id), a.results.map((r) => r.id));

  const client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
  const names = (await client.getCollections()).collections.map((c) => c.name).filter((name) => name.startsWith(`docs_qdrant_${process.pid}`));
  assert.equal(names.length, 1);
  assert.equal((await client.getCollection(names[0])).points_count, 40);
});
