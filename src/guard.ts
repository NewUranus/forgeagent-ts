import path from "node:path";

// Two layers keep "pass by editing the tests" out: tools refuse protected writes at the entry,
// and the completion check compares every file with the baseline at the exit, whatever made the change.

export function isTestFile(name: string) {
  return /(^|\/)(test[s]?|__tests__)(\/|\.)|(^|\/)test_|[._](test|spec)\.[^.]+$/.test(name);
}

// Files whose only purpose is configuring a test runner; editing them can skip or rewrite tests.
const TEST_CONFIG =
  /(^|\/)(conftest\.py|pytest\.ini|\.mocharc(\.[a-z]+)?|(jest|vitest|karma|playwright|cypress|ava)\.config\.[cm]?[jt]s(on)?|karma\.conf\.[cm]?js)$/;

export function isTestConfig(name: string) {
  return TEST_CONFIG.test(name);
}

export function isProtected(name: string) {
  return isTestFile(name) || isTestConfig(name);
}

const pick = (value: unknown, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, (value as Record<string, unknown> | undefined)?.[key] ?? null]));

function iniSections(content: string, header: RegExp) {
  const lines: string[] = [];
  let inside = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inside = header.test(line.trim());
    if (inside) lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

/**
 * Shared files mix test settings with other configuration, so they stay editable,
 * but their test-related part must not change. Returns that part, or null for other files.
 */
export function testSettings(name: string, content: string | null): string | null {
  if (content === null) return null;
  const base = path.posix.basename(name);
  if (base === "package.json") {
    try {
      const pkg = JSON.parse(content);
      return JSON.stringify({ scripts: pick(pkg.scripts, ["test", "pretest", "posttest"]), ...pick(pkg, ["jest", "mocha", "ava"]) });
    } catch {
      return "（无法解析的 package.json）";
    }
  }
  if (base === "pyproject.toml") return iniSections(content, /^\[tool\.pytest[\].]/);
  if (base === "setup.cfg") return iniSections(content, /^\[tool:pytest\]/);
  if (base === "tox.ini") return iniSections(content, /^\[(pytest|testenv[^\]]*)\]/);
  return null;
}

/** Reject a write whose new content changes the test settings of a shared file. */
export function assertTestSettingsUnchanged(name: string, before: string | null, after: string) {
  if (testSettings(name, before) !== testSettings(name, after))
    throw new Error(`禁止修改 ${name} 中的测试配置（如 scripts.test、pytest 配置段）`);
}

/** Exit check: list every change to tests or test settings since the baseline snapshot. */
export function findTestTampering(baseline: Map<string, Buffer>, current: Map<string, Buffer>): string[] {
  const issues: string[] = [];
  for (const name of [...new Set([...baseline.keys(), ...current.keys()])].sort()) {
    const before = baseline.get(name) ?? null, after = current.get(name) ?? null;
    if (before && after && before.equals(after)) continue;
    if (isProtected(name)) {
      issues.push(`${before === null ? "新增" : after === null ? "删除" : "修改"}了测试文件或测试配置 ${name}`);
    } else if (testSettings(name, before?.toString("utf8") ?? null) !== testSettings(name, after?.toString("utf8") ?? null)) {
      issues.push(`修改了 ${name} 中的测试配置`);
    }
  }
  return issues;
}
