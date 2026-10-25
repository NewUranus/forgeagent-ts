import test from "node:test";
import assert from "node:assert/strict";
import { firstSubmitter, rankOf, topN } from "./scores.ts";

const submissions = () => [
  { player: "ann", score: 50 },
  { player: "bo", score: 90 },
  { player: "cy", score: 70 },
];

test("topN returns the highest scores", () => {
  assert.deepEqual(topN(submissions(), 2).map((s) => s.player), ["bo", "cy"]);
});
test("topN leaves the input order alone", () => {
  const list = submissions();
  topN(list, 2);
  assert.deepEqual(list.map((s) => s.player), ["ann", "bo", "cy"]);
});
test("first submitter is still right after ranking", () => {
  const list = submissions();
  assert.equal(rankOf(list, "ann"), 3);
  assert.equal(firstSubmitter(list), "ann");
});
