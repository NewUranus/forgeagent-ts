import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
export const ignored = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".DS_Store", "dist"]);
export function ignoreName(name: string) { return ignored.has(name) || name === ".env" || name.startsWith(".env.") || name.endsWith(".bak"); }
export async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignoreName(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) result.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root); return result.sort();
}
export async function projectPath(root: string, relative: string, write = false): Promise<string> {
  if (!relative || path.isAbsolute(relative)) throw new Error("必须提供项目内相对路径");
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, relative);
  if (!target.startsWith(realRoot + path.sep)) throw new Error("路径超出工作目录");
  const parts = path.relative(realRoot, target).split(path.sep);
  if (parts.some(ignoreName)) throw new Error("该路径不允许访问");
  let current = realRoot;
  for (const part of parts) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("不允许符号链接"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !write) throw error; }
  }
  return target;
}
export async function createWorkspace(source: string, base: string) {
  source = await fs.realpath(source);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const taskDir = path.resolve(base, "workspace", id);
  const projectDir = path.join(taskDir, "project");
  if (projectDir.startsWith(source + path.sep)) throw new Error("工作副本不能位于源项目内部");
  await fs.mkdir(taskDir, { recursive: true });
  await fs.cp(source, projectDir, { recursive: true, filter: async p => !ignoreName(path.basename(p)) && !(await fs.lstat(p)).isSymbolicLink() });
  return { id, taskDir, projectDir, source };
}
export async function diffWorkspace(source: string, root: string, baseline?: Map<string, string>) {
  const names = [...new Set([...(baseline ? baseline.keys() : await listFiles(source)), ...await listFiles(root)])].sort();
  const changes: { path: string; before: string; after: string; deleted: boolean }[] = [];
  let patch = "";
  for (const name of names) {
    if (!/\.(ts|js|json|py|md|txt)$/.test(name)) continue;
    const read = (base: string) => fs.readFile(path.join(base, name), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
    const before = baseline ? (baseline.get(name) ?? "") : await read(source), after = await read(root);
    const deleted = !await fs.stat(path.join(root, name)).then(() => true, () => false);
    if (before === after) continue;
    patch += createTwoFilesPatch(`a/${name}`, `b/${name}`, before, after);
    changes.push({ path: name, before, after, deleted });
  }
  return { changes, patch };
}
