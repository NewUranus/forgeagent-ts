import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { ROOT } from "../config.js";
import { postJson } from "../config.js";
export function normalize(vector: number[]): number[] {
  if (!vector.length || !vector.every(Number.isFinite)) throw new Error("无效向量");
  const norm = Math.hypot(...vector);
  if (!norm) throw new Error("不能归一化零向量");
  return vector.map(v => v / norm);
}
export async function embed(texts: string[], model = process.env.EMBEDDING_MODEL ?? "Qwen3-Embedding-0.6B"): Promise<number[][]> {
  const base = process.env.EMBEDDING_BASE_URL;
  if (!base) {
    if (model !== "Qwen3-Embedding-0.6B") throw new Error("本地适配器仅用于 Qwen3-Embedding-0.6B；其他模型请配置服务端点");
    return new Promise((resolve, reject) => {
      const worker = spawn(process.env.PYTHON ?? "python3", [path.join(ROOT, "src/rag/embedding-worker.py")], { stdio: ["pipe", "pipe", "inherit"] });
      let output = "";
      worker.stdout.on("data", data => { output += data; });
      worker.on("error", reject);
      worker.stdin.on("error", reject);
      worker.on("close", code => {
        if (code !== 0) { reject(new Error(`本地 embedding 进程退出：${code}`)); return; }
        try {
          const vectors = JSON.parse(output);
          if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error("向量数量错误");
          resolve(vectors.map(normalize));
        } catch (error) { reject(error); }
      });
      worker.stdin.end(JSON.stringify({ texts, model_path: process.env.EMBEDDING_MODEL_PATH ?? path.join(os.homedir(), "qwen3-embedding-0.6b") }));
    });
  }
  const result: number[][] = [];
  for (let start = 0; start < texts.length; start += 8) {
    const batch = texts.slice(start, start + 8);
    const response = await postJson(base, "embeddings", { model, input: batch, encoding_format: "float" }, process.env.EMBEDDING_API_KEY);
    if (!Array.isArray(response.data) || response.data.length !== batch.length) throw new Error("Embedding 返回数量不匹配");
    const rows = response.data.sort((a: {index: number}, b: {index: number}) => a.index - b.index);
    rows.forEach((row: { index: number; embedding: number[] }, i: number) => {
      if (row.index !== i || !Array.isArray(row.embedding)) throw new Error("Embedding 返回格式错误");
      result.push(normalize(row.embedding));
    });
  }
  if (result.some(v => v.length !== result[0].length)) throw new Error("Embedding 维度不一致");
  return result;
}
export const queryPrompt = (question: string) => `Instruct: Given a question about Python programming, retrieve relevant textbook passages that answer the question.\nQuery:${question}`;
