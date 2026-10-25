import test from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "./lru.ts";

test("evicts the least recently inserted when nothing was read", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1); cache.set("b", 2); cache.set("c", 3);
  assert.equal(cache.has("a"), false);
  assert.equal(cache.size, 2);
});
test("a read counts as a use", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1); cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
});
test("an update counts as a use", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1); cache.set("b", 2); cache.set("a", 10); cache.set("c", 3);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.has("b"), false);
});
test("reading a missing key changes nothing", () => {
  const cache = new LRUCache<string, number>(1);
  cache.set("a", 1);
  assert.equal(cache.get("zzz"), undefined);
  assert.equal(cache.size, 1);
});
test("rejects bad capacity", () => assert.throws(() => new LRUCache(0), RangeError));
