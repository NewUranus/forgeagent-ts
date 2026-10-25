import test from "node:test";
import assert from "node:assert/strict";
import { pageCount, pageItems } from "./paginate.ts";

const items = Array.from({ length: 10 }, (_, i) => i + 1);

test("pageCount rounds partial pages up", () => {
  assert.equal(pageCount(10, 3), 4);
  assert.equal(pageCount(1, 5), 1);
});
test("pageCount exact and empty", () => {
  assert.equal(pageCount(9, 3), 3);
  assert.equal(pageCount(0, 5), 0);
});
test("pageCount rejects non-positive size", () => assert.throws(() => pageCount(3, 0), RangeError));
test("last partial page has the remaining items", () => assert.deepEqual(pageItems(items, 4, 3), [10]));
test("middle page", () => assert.deepEqual(pageItems(items, 2, 3), [4, 5, 6]));
test("out of range pages are empty", () => {
  assert.deepEqual(pageItems(items, 5, 3), []);
  assert.deepEqual(pageItems(items, 0, 3), []);
});
