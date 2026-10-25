import test from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "./retry.ts";

test("succeeds on the last allowed attempt", async () => {
  let calls = 0;
  const result = await withRetry(async (attempt) => {
    calls++;
    if (attempt < 3) throw new Error(`fail ${attempt}`);
    return "ok";
  }, { attempts: 3 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});
test("rethrows the last error when every attempt fails", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async (attempt) => {
    calls++;
    throw new Error(`fail ${attempt}`);
  }, { attempts: 2 }), /fail 2/);
  assert.equal(calls, 2);
});
test("a single attempt still runs once", async () => {
  assert.equal(await withRetry(async () => 42, { attempts: 1 }), 42);
});
test("rejects bad attempts", async () => {
  await assert.rejects(withRetry(async () => 1, { attempts: 0 }), RangeError);
});
