import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { ROOT } from '../src/config.ts';
import { createWorkspace, projectPath } from '../src/workspace.ts';
import { runTests, executeTool } from '../src/tools.ts';
import { runAgent } from '../src/agent.ts';
import { runRepairDemo } from '../src/runner.ts';
import { chunkPages } from '../src/rag/chunker.ts';
import { search, loadIndex } from '../src/rag/retriever.ts';
import { embed } from '../src/rag/embedding.ts';
import { MCPClient } from '../src/mcp/client.ts';
import { handle } from '../src/mcp/server.ts';
import type { Message } from '../src/types.ts';
async function temp(t: any) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-ts-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
// The interactive playground deliberately contains a bug. Infrastructure tests need a stable passing fixture.
async function healthySource(base: string) {
  const source = path.join(base, 'source');
  await fs.cp(path.join(ROOT, 'playground'), source, { recursive: true });
  const file = path.join(source, 'stats_helpers.ts');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('.length + 1', '.length'));
  return source;
}
const call = (name: string, args = {}): Message => ({ role: 'assistant', content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('working copy, tools and six calculator cases', async t => {
  const base = await temp(t);
  const { projectDir: root, taskDir } = await createWorkspace(await healthySource(base), base);
  assert.equal((await runTests(root)).exit_code, 0);
  await assert.rejects(projectPath(root, '../outside'), /超出/);
  await fs.symlink('/tmp', path.join(root, 'escape'));
  await assert.rejects(projectPath(root, 'escape/file', true), /符号链接/);
  await assert.rejects(executeTool(root, 'write_file', { relative_path: 'calculator.test.ts', content: '' }), /测试/);
  assert.ok((await executeTool(root, 'search_code', { keyword: 'average' }) as any[]).length);
  await executeTool(root, 'update_plan', { steps: [{ id: 'step_1', description: 'inspect', status: 'in_progress' }] });
  await executeTool(root, 'update_plan', { steps: [{ id: 'step_1', description: 'inspect', status: 'completed' }] });
  assert.equal((await fs.readFile(path.join(taskDir, 'plans.jsonl'), 'utf8')).trim().split('\n').length, 2);
});
test('test timeout is a result, not an unbound-variable error', async t => {
  const root = await temp(t);
  await fs.writeFile(path.join(root, 'slow.test.ts'), 'import test from "node:test"; test("slow", async()=>{ await new Promise(r=>setTimeout(r,10000)); });');
  const result = await runTests(root, 300);
  assert.equal(result.time_out, true); assert.notEqual(result.exit_code, 0);
});
test('MCP discovery, errors, and real file/test tools over stdio', async t => {
  const base = await temp(t);
  const { projectDir: root, taskDir } = await createWorkspace(await healthySource(base), base);
  const client = new MCPClient(new URL('../src/mcp/server.ts', import.meta.url), root);
  try {
    assert.deepEqual((await client.request('server/discover')).supportedVersions, ['2026-07-28']);
    assert.ok((await client.listTools()).some(tool => tool.name === 'list_files'));
    assert.ok((await client.callTool('list_files', {}) as string[]).includes('calculator.ts'));
    assert.equal((await client.callTool('run_tests', {}) as any).exit_code, 0);
    await assert.rejects(client.callTool('read_file', { relative_path: '../outside' }), /超出/);
    await assert.rejects(client.request('unknown'), /32601/);
  } finally { await client.close(); }
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, root) as any).error.code, -32602);
});
test('agent mock works locally and through MCP without credentials', async t => {
  const base = await temp(t);
  const source = await healthySource(base);
  for (const mcp of [false, true]) {
    const report = await runAgent({ base, source, mock: true, mcp });
    assert.equal(report.status, 'passed');
    assert.equal(report.workspace, path.join(report.task_dir, 'project'));
    const artifacts = (await fs.readdir(report.task_dir)).sort();
    assert.deepEqual(artifacts, ['changes.patch', 'model', 'plan.json', 'plans.jsonl', 'project', 'report.json', 'report.txt', 'tests.jsonl', 'trace.jsonl']);
    const history = (await fs.readFile(path.join(report.task_dir, 'plans.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(history.length, 3);
    const files = await executeTool(report.workspace, 'list_files', {}) as string[];
    assert.ok(!files.some(f => /plan|trace|report/.test(f)));
    await assert.rejects(executeTool(report.workspace, 'read_file', { relative_path: '../plan.json' }), /超出/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(report.task_dir, 'report.json'), 'utf8')), report);
  }
  for (const entry of await fs.readdir(path.join(base, 'workspace'), { withFileTypes: true })) assert.ok(entry.isDirectory());
});
test('write after passing tests invalidates success; source stays unchanged', async t => {
  const base = await temp(t);
  const source = await healthySource(base);
  const before = await fs.readFile(path.join(source, 'calculator.ts'), 'utf8');
  const replies = [call('run_tests'), call('write_file', { relative_path: 'calculator.ts', content: 'export function average(){return -1}' }), { role: 'assistant', content: '完成' } as Message];
  const report = await runAgent({ base, source, apply: true, maxRounds: replies.length, reply: async () => replies.shift()! });
  assert.equal(report.status, 'limit_reached'); assert.equal(report.applied, false);
  assert.equal(await fs.readFile(path.join(source, 'calculator.ts'), 'utf8'), before);
});
test('runner handles syntax failure and test failure then repairs', async t => {
  const base = await temp(t);
  const report = await runRepairDemo(base, await healthySource(base));
  assert.equal(report.final_status, 'passed');
  assert.deepEqual(report.history.map((r: any) => r.status), ['failed', 'error', 'failed', 'passed']);
});
test('chunks preserve overlap and reject non-terminating settings', () => {
  const pages = [{ source: 'book', page: 1, content: 'abcdefghij' }];
  const chunks = chunkPages(pages, 6, 2);
  assert.deepEqual(chunks.map(c => c.content), ['abcdef', 'efghij']);
  assert.throws(() => chunkPages(pages, 6, 6));
});
test('legacy Python index loads and cosine ranking is correct', async t => {
  const root = await temp(t), file = path.join(root, 'index.json');
  const chunks = chunkPages([{ source: 'book', page: 1, content: 'abc' }, { source: 'book', page: 2, content: 'xyz' }]);
  await fs.writeFile(file, JSON.stringify({ model: '', demension: 2, normalized: true, chunks: chunks.map((c,i)=>({...c,embedding:i ? [0,1] : [1,0]})) }));
  const index = await loadIndex(file);
  assert.equal(search(index, [0,2], 1)[0].page, 2);
  assert.throws(() => search(index, [1,2,3]));
});
test('embedding HTTP adapter orders and normalizes results', async () => {
  const old = process.env.EMBEDDING_BASE_URL;
  const server = createServer((req,res) => { req.resume(); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({data:[{index:1,embedding:[0,2]},{index:0,embedding:[3,0]}]})); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  try { assert.deepEqual(await embed(['one','two']), [[1,0],[0,1]]); }
  finally { if (old === undefined) delete process.env.EMBEDDING_BASE_URL; else process.env.EMBEDDING_BASE_URL = old; server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); }
});
test('chat endpoint tool-call loop executes and applies a verified repair', async t => {
  const base = await temp(t), source = await healthySource(base);
  const original = await fs.readFile(path.join(source,'calculator.ts'),'utf8');
  await fs.writeFile(path.join(source,'calculator.ts'),'export function average(){return -1}');
  const responses = [call('read_file', {relative_path:'calculator.ts'}), call('write_file', {relative_path:'calculator.ts',content:original}), call('run_tests'), call('update_plan', {steps:[{id:'repair',description:'repair and verify',status:'completed'}]}), {role:'assistant',content:'done'}];
  let calls = 0;
  const server = createServer(async (req,res) => {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body);
    assert.equal(request.model, 'mock-http'); assert.ok(request.tools.length > 0);
    if (calls) assert.equal(request.messages.at(-1).role, 'tool');
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({choices:[{message:responses[calls++]}]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const old = {provider:process.env.MODEL_PROVIDER,key:process.env.TEST_API_KEY,base:process.env.TEST_BASE_URL,model:process.env.TEST_MODEL};
  Object.assign(process.env,{MODEL_PROVIDER:'TEST',TEST_API_KEY:'local-test',TEST_BASE_URL:`http://127.0.0.1:${(server.address() as any).port}/v1`,TEST_MODEL:'mock-http'});
  try {
    const result = await runAgent({base,source,apply:true,mock:false});
    assert.equal(result.status,'passed'); assert.equal(result.applied,true); assert.equal(calls,5);
    assert.equal(await fs.readFile(path.join(source,'calculator.ts'),'utf8'),original);
  } finally {
    for (const [key,value] of Object.entries({MODEL_PROVIDER:old.provider,TEST_API_KEY:old.key,TEST_BASE_URL:old.base,TEST_MODEL:old.model})) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
    server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));
  }
});

test('tool schemas list every required field in properties', async () => {
  const { tools } = await import('../src/tools.ts');
  const check = (schema: any, where: string) => {
    if (!schema || typeof schema !== 'object') return;
    for (const name of schema.required ?? [])
      assert.ok(schema.properties && name in schema.properties, `${where}: required 字段 ${name} 不在 properties 中`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) check(child, `${where}.${key}`);
    if (schema.items) check(schema.items, `${where}[]`);
  };
  for (const tool of tools) check(tool.inputSchema, tool.name);
});
