import { promises as fs } from "node:fs";
import path from "node:path";

/** Save the request before invoking the model, including when it hangs or fails. */
export async function logModelRound<T>(
  taskDir: string,
  round: number,
  mode: "api" | "mock" | "custom" | "replay",
  request: unknown,
  invoke: () => Promise<T>,
): Promise<T> {
  const dir = path.join(taskDir, "model", `round-${String(round).padStart(3, "0")}`);
  await fs.mkdir(dir, { recursive: true });
  const save = (name: string, value: unknown) =>
    fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2) + "\n");
  const startedAt = new Date().toISOString();
  const start = performance.now();
  await save("request.json", request);
  await save("meta.json", { round, mode, started_at: startedAt, status: "pending" });
  console.log(`\n[模型第 ${round} 轮 / ${mode}] 请求：${path.join(dir, "request.json")}`);
  try {
    const response = await invoke();
    // Save the untouched API JSON before extracting choices[0].message.
    await save("response.json", response);
    await save("meta.json", { round, mode, started_at: startedAt, ended_at: new Date().toISOString(), duration_ms: Math.round(performance.now() - start), status: "completed" });
    console.log(`[模型第 ${round} 轮] 返回：${path.join(dir, "response.json")}`);
    return response;
  } catch (error) {
    await save("error.json", { name: error instanceof Error ? error.name : "Error", message: String(error) });
    await save("meta.json", { round, mode, started_at: startedAt, ended_at: new Date().toISOString(), duration_ms: Math.round(performance.now() - start), status: "error" });
    console.error(`[模型第 ${round} 轮] 错误：${path.join(dir, "error.json")}`);
    throw error;
  }
}
