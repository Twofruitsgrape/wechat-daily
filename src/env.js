import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录（src/ 的上一级），所有相对路径都从这里算，cron 里 cd 不 cd 都无所谓
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 极简 .env 解析器：不引 dotenv，避免多一个依赖。
 * 已存在的 process.env 优先（方便用环境变量临时覆盖）。
 */
export function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export const env = (key, fallback = "") => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
};

// 模块被导入时自动加载一次 .env。
// 这样任何单独跑的工具（比如 `node -e` 里 import client.js）也能拿到配置，
// 不需要每个入口记得先调 loadEnv()。幂等，已存在的环境变量不会被覆盖。
loadEnv();

/** 必填项缺失时直接抛错，避免跑到一半才发现没配 */
export function requireEnv(keys) {
  const missing = keys.filter((k) => !env(k));
  if (missing.length) {
    throw new Error(
      `缺少必要的环境变量：${missing.join(", ")}\n` +
        `请在 ${path.join(ROOT, ".env")} 中补上（参考 .env.example）`
    );
  }
}
