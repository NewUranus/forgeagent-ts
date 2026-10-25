import test from "node:test";
import assert from "node:assert/strict";
import { slugify, uniqueSlug } from "./slug.ts";

for (const [title, slug] of [
  ["Hello World", "hello-world"],
  ["Make  It   Work", "make-it-work"],
  ["Rock & Roll!", "rock-roll"],
  ["  Trim me  ", "trim-me"],
  ["Already-slug", "already-slug"],
  ["a -- b", "a-b"],
  ["Version 2.0 Notes", "version-20-notes"],
]) {
  test(`slugify(${JSON.stringify(title)})`, () => assert.equal(slugify(title), slug));
}
test("uniqueSlug appends a counter", () => {
  assert.equal(uniqueSlug("Hello World", new Set(["hello-world", "hello-world-2"])), "hello-world-3");
});
