import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { logModelRound } from "../src/model-log.ts";

test("records request before invocation, preserves raw response and snapshots", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-log-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const location = path.join(dir, "model/round-001");
  const request = { model: "local", messages: [{ role: "user", content: "修复" }], tools: [] };
  const response = { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "a" }] } }], usage: { total_tokens: 42 } };
  const result = await logModelRound(dir, 1, "api", request, async () => {
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(location, "request.json"), "utf8")), request);
    return response;
  });
  assert.deepEqual(result, response);
  request.messages.push({ role: "tool", content: "后续消息" });
  assert.equal(JSON.parse(await fs.readFile(path.join(location, "request.json"), "utf8")).messages.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(location, "response.json"), "utf8")), response);
  assert.equal(JSON.parse(await fs.readFile(path.join(location, "meta.json"), "utf8")).status, "completed");
});
test("failed call keeps request and error without inventing a response", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-log-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(logModelRound(dir, 2, "api", { messages: [] }, async () => { throw new Error("timeout"); }), /timeout/);
  const location = path.join(dir, "model/round-002");
  assert.deepEqual((await fs.readdir(location)).sort(), ["error.json", "meta.json", "request.json"]);
  assert.equal(JSON.parse(await fs.readFile(path.join(location, "meta.json"), "utf8")).status, "error");
});
