import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ROOT } from "./env.js";

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readYaml(relPath) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) throw new Error(`找不到配置文件：${abs}`);
  return YAML.parse(fs.readFileSync(abs, "utf8")) ?? {};
}

/** 原子写 JSON：先写 .tmp 再 rename，断电也不会写出半个文件 */
export function writeJsonAtomic(absPath, data) {
  ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, absPath);
}

export function readJson(absPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return fallback;
  }
}

/** 按指定时区取 YYYY-MM-DD，避免容器/机器时区把日期算错 */
export function dateInTZ(tz = "Asia/Shanghai", d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // en-CA 天然是 YYYY-MM-DD
}

export function timeInTZ(tz = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 汉字计数：只数中日韩字符，用来判断正文字数够不够 */
export function countHan(text) {
  const m = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

/** 简易 logger，同时写 console 和 data/logs/日期.log */
export function createLogger(dateStr) {
  const dir = ensureDir(path.join(ROOT, "data", "logs"));
  const file = path.join(dir, `run-${dateStr}.log`);
  const write = (level, msg) => {
    const line = `[${new Date().toISOString()}] ${level} ${msg}`;
    console.log(line);
    try {
      fs.appendFileSync(file, line + "\n", "utf8");
    } catch {
      /* 日志写不进去不该影响主流程 */
    }
  };
  return {
    file,
    info: (m) => write("INFO ", m),
    warn: (m) => write("WARN ", m),
    error: (m) => write("ERROR", m),
    step: (n, total, m) => write("STEP ", `(${n}/${total}) ${m}`),
  };
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** ISO 时间戳，方便写进 state / meta */
export const nowIso = () => new Date().toISOString();
