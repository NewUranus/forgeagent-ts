import test from "node:test";
import assert from "node:assert/strict";
import { loadAll } from "./loader.ts";

const delayed = (delays: Record<string, number>) => (id: string) =>
  new Promise<string>((resolve) => setTimeout(() => resolve(id.toLowerCase()), delays[id] ?? 0));

test("returns every result", async () => {
  assert.deepEqual(await loadAll(["A", "B"], delayed({})), ["a", "b"]);
});
test("keeps the order of ids even when later ids finish first", async () => {
  assert.deepEqual(await loadAll(["A", "B", "C"], delayed({ A: 30, B: 5, C: 15 })), ["a", "b", "c"]);
});
test("empty input", async () => assert.deepEqual(await loadAll([], delayed({})), []));
test("a failure rejects the call", async () => {
  await assert.rejects(loadAll(["A", "B"], async (id) => {
    if (id === "B") throw new Error("B failed");
    return id;
  }), /B failed/);
});
