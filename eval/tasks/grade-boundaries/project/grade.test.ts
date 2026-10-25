import test from "node:test";
import assert from "node:assert/strict";
import { gradeReport, letterGrade } from "./grade.ts";

for (const [score, letter] of [[100, "A"], [90, "A"], [89.5, "B"], [80, "B"], [70, "C"], [69.9, "D"], [60, "D"], [59.9, "F"], [0, "F"]] as const) {
  test(`letterGrade(${score}) is ${letter}`, () => assert.equal(letterGrade(score), letter));
}
test("rejects scores outside 0-100", () => {
  assert.throws(() => letterGrade(101), RangeError);
  assert.throws(() => letterGrade(-1), RangeError);
  assert.throws(() => letterGrade(Number.NaN), RangeError);
});
test("gradeReport maps every student", () => {
  assert.deepEqual(gradeReport({ ann: 90, bo: 79 }), { ann: "A", bo: "C" });
});
