import test from "node:test";
import assert from "node:assert/strict";
import { average } from "./calculator.ts";
for (const [input, expected] of [ [[2,4,6],4], [[5],5], [[],0], [[2,null,4],3], [[null,null],0], [[0,null,4],2] ] as [(number|null)[], number][]) {
  test(`average(${JSON.stringify(input)})`, () => assert.equal(average(input), expected));
}
