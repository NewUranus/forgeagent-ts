import test from "node:test";
import assert from "node:assert/strict";
import { parseSettings } from "./settings.ts";

test("defaults", () => assert.deepEqual(parseSettings({}), { port: 3000, debug: false, retries: 2, tags: [] }));
test("numbers", () => {
  const settings = parseSettings({ PORT: "8080", RETRIES: "5" });
  assert.equal(settings.port, 8080);
  assert.equal(settings.retries, 5);
});
for (const value of ["false", "0", "no", "off", "FALSE"]) {
  test(`DEBUG=${value} is off`, () => assert.equal(parseSettings({ DEBUG: value }).debug, false));
}
for (const value of ["true", "1", "yes", "on", "True"]) {
  test(`DEBUG=${value} is on`, () => assert.equal(parseSettings({ DEBUG: value }).debug, true));
}
test("tags are trimmed and empty entries dropped", () => {
  assert.deepEqual(parseSettings({ TAGS: " api, web ,,jobs" }).tags, ["api", "web", "jobs"]);
});
