import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
export const ignored = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".DS_Store", "dist"]);
export function ignoreName(name: string) { return ignored.has(name) || name === ".env" || name.startsWith(".env.") || name.endsWith(".bak"); }
const execFileAsync = promisify(execFile);
export const git = async (cwd: string, args: string[]) =>
  (await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;

// In a git worktree, list tracked and untracked-but-not-ignored files, so .gitignore keeps
// dependencies and build output out of diffs, snapshots and searches.
async function gitFiles(root: string): Promise<string[] | null> {
  if (!(await fs.lstat(path.join(root, ".git")).then(() => true, () => false))) return null;
  let output: string;
  try { output = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]); }
  catch { return null; }
  const result: string[] = [];
  for (const name of new Set(output.split("\0").filter(Boolean))) {
    if (name.split("/").some(ignoreName)) continue;
    // Deleted tracked files are still in the index; symlinks are skipped like in the directory walk.
    if ((await fs.lstat(path.join(root, name)).catch(() => null))?.isFile()) result.push(name);
  }
  return result.sort();
}
export async function listFiles(root: string): Promise<string[]> {
  const tracked = await gitFiles(root);
  if (tracked) return tracked;
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
export type WorkspaceMode = "copy" | "git";
/**
 * "copy" copies the source minus dependencies and secrets. "git" adds a worktree on a new
 * branch forge/<task-id>: only committed content, .gitignore respected, results land as a commit.
 */
export async function createWorkspace(source: string, base: string, mode: WorkspaceMode = "copy") {
  source = await fs.realpath(source);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const taskDir = path.resolve(base, "workspace", id);
  const projectDir = path.join(taskDir, "project");
  if (projectDir.startsWith(source + path.sep)) throw new Error("工作副本不能位于源项目内部");
  if (mode === "git") {
    const top = await git(source, ["rev-parse", "--show-toplevel"]).then(
      (out) => fs.realpath(out.trim()),
      () => { throw new Error("git 模式要求源目录是 git 仓库"); },
    );
    if (top !== source) throw new Error(`git 模式要求指向仓库根目录：${top}`);
    if ((await git(source, ["status", "--porcelain", "--untracked-files=no"])).trim())
      throw new Error("源仓库有未提交的修改；git 模式只包含已提交的内容，请先提交，或改用 copy 模式");
    const branch = `forge/${id}`;
    await fs.mkdir(taskDir, { recursive: true });
    await git(source, ["worktree", "add", "--quiet", "-b", branch, projectDir, "HEAD"]);
    return { id, taskDir, projectDir, source, mode, branch };
  }
  await fs.mkdir(taskDir, { recursive: true });
  await fs.cp(source, projectDir, { recursive: true, filter: async p => !ignoreName(path.basename(p)) && !(await fs.lstat(p)).isSymbolicLink() });
  return { id, taskDir, projectDir, source, mode, branch: null as string | null };
}

/** Commit every change in a git worktree on its own branch; the user merges it, nothing touches their checkout. */
export async function commitWorkspace(projectDir: string, message: string) {
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["-c", "user.name=ForgeAgent", "-c", "user.email=forgeagent@localhost", "commit", "--quiet", "--no-verify", "-m", message]);
  return (await git(projectDir, ["rev-parse", "HEAD"])).trim();
}
/** Snapshot every copied file as bytes, so later diffs and checks see all file types. */
export async function snapshotFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const name of await listFiles(root)) files.set(name, await fs.readFile(path.join(root, name)));
  return files;
}
export const isBinary = (data: Buffer) => data.includes(0);
export interface FileChange {
  path: string;
  before: Buffer | null; // null: the file did not exist
  after: Buffer | null; // null: the file was deleted
  binary: boolean;
}
// Text files get a unified diff; binary files are listed but have no patch body.
export async function diffWorkspace(source: string, root: string, baseline?: Map<string, Buffer>) {
  const before = baseline ?? await snapshotFiles(source);
  const after = await snapshotFiles(root);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: FileChange[] = [];
  let patch = "";
  for (const name of names) {
    const a = before.get(name) ?? null, b = after.get(name) ?? null;
    if (a && b && a.equals(b)) continue;
    const binary = Boolean((a && isBinary(a)) || (b && isBinary(b)));
    patch += binary
      ? `Binary files a/${name} and b/${name} differ\n`
      : createTwoFilesPatch(`a/${name}`, `b/${name}`, a?.toString("utf8") ?? "", b?.toString("utf8") ?? "");
    changes.push({ path: name, before: a, after: b, binary });
  }
  return { changes, patch };
}
