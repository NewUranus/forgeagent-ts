import test from "node:test";
import assert from "node:assert/strict";
import { displayName, mentionList } from "./users.ts";

test("uses the trimmed nickname", () => assert.equal(displayName({ id: 1, name: "ali", profile: { nickname: "  Ali  " } }), "Ali"));
test("no profile falls back to name", () => assert.equal(displayName({ id: 2, name: "bo" }), "bo"));
test("null profile falls back to name", () => assert.equal(displayName({ id: 3, name: "cy", profile: null }), "cy"));
test("missing or null nickname falls back to name", () => {
  assert.equal(displayName({ id: 4, name: "di", profile: {} }), "di");
  assert.equal(displayName({ id: 5, name: "ed", profile: { nickname: null } }), "ed");
});
test("blank nickname falls back to name", () => assert.equal(displayName({ id: 6, name: "fa", profile: { nickname: "   " } }), "fa"));
test("mentionList handles mixed users", () => {
  assert.equal(mentionList([{ id: 1, name: "ali", profile: { nickname: "Ali" } }, { id: 2, name: "bo" }]), "@Ali, @bo");
});
