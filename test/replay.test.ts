import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../src/config.ts";
import { loadReplay } from "../src/replay.ts";
import { runAgent } from "../src/agent.ts";

const recording = path.join(ROOT, "mock-data/2026-10-17T08-20-57-131Z_619f7ef9");

test("Qwen recording repairs a copy without network and logs replay provenance", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-replay-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in replay"); });
  const before = await fs.readFile(path.join(ROOT, "playground/stats_helpers.ts"), "utf8");
  const report = await runAgent({ base, replay: recording });
  assert.equal(report.status, "passed");
  assert.equal(report.applied, false);
  assert.equal(report.task.mode, "replay");
  assert.equal(report.statistics.model.api_calls, 0);
  assert.equal(report.statistics.model.usage.total_tokens, null);
  assert.equal(report.tests.comparison, "failed_to_passed");
  assert.equal(report.tests.latest_is_current, true);
  assert.ok(report.changed_files.includes("stats_helpers.ts"));
  assert.equal(await fs.readFile(path.join(ROOT, "playground/stats_helpers.ts"), "utf8"), before);
  const meta = JSON.parse(await fs.readFile(path.join(report.task_dir, "model/round-009/meta.json"), "utf8"));
  assert.equal(meta.mode, "replay");
  const replay = await loadReplay(recording);
  for (let i = 0; i < replay.length; i++) replay.next();
  assert.throws(() => replay.next(), /已耗尽/);
  await assert.rejects(runAgent({ base, replay: recording, mock: true }), /不能/);
});

test("rejects missing responses, pending recordings, and gaps before execution", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "forge-replay-invalid-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dir = path.join(base, "model/round-001");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ mode: "api", status: "pending" }));
  await assert.rejects(loadReplay(base), /已完成/);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ mode: "api", status: "completed" }));
  await assert.rejects(loadReplay(base), /response.json/);
  await fs.rename(dir, path.join(base, "model/round-002"));
  await assert.rejects(loadReplay(base), /不连续/);
});
