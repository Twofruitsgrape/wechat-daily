#!/usr/bin/env node
/**
 * 配置向导：把凭证写进 .env（幂等，保留已有内容）。
 *
 * 交互式（推荐给人用）：
 *   node scripts/setup.mjs
 *
 * 非交互式（推荐给 agent 用，密钥不会进 shell 历史的话更好）：
 *   node scripts/setup.mjs --set WECHAT_APPID=wx... --set WECHAT_APPSECRET=...
 *   node scripts/setup.mjs --from-env        # 从当前 shell 环境变量读取
 *
 * 只检查，不写文件：
 *   node scripts/setup.mjs --check
 *
 * 原则：
 *   - 已存在的 .env 只在原有行上改值，注释和顺序都保留
 *   - 改之前备份成 .env.bak（同样被 gitignore）
 *   - POSIX 下自动 chmod 600
 *   - 屏幕上不回显完整密钥
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const EXAMPLE_PATH = path.join(ROOT, ".env.example");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const KNOWN_KEYS = [
  "WECHAT_APPID",
  "WECHAT_APPSECRET",
  "WECHAT_AUTHOR",
  "WECHAT_SOURCE_URL",
  "WECHAT_BASE_URL",
  "OPENCODE_API_KEY",
  "OPENCODE_BASE_URL",
  "OPENCODE_MODEL",
  "OPENCODE_MODEL_FAST",
  "PAPER_VISION_MODEL",
  "PUBLISH_MODE",
  "NOTIFY_CHANNEL",
  "NOTIFY_WEBHOOK_URL",
  "NOTIFY_SERVERCHAN_KEY",
  "WECOM_CORPID",
  "WECOM_CORPSECRET",
  "WECOM_AGENTID",
  "WECOM_TOKEN",
  "WECOM_AESKEY",
  "WECOM_ALLOWED_USERS",
  "WECOM_BOT_ID",
  "WECOM_BOT_SECRET",
  "BOT_PORT",
  "WEB_PORT",
  "WEB_HOST",
  "WEB_TOKEN",
  "PI_BIN",
  "PI_MODEL",
  "PI_THINKING",
];

const REQUIRED = ["WECHAT_APPID", "WECHAT_APPSECRET", "OPENCODE_API_KEY"];

/* ------------------------------ 解析 .env ------------------------------ */

function parseEnv(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map.set(k, v);
  }
  return map;
}

/** 在原文上就地改值，保留注释；没有的键追加到末尾 */
function mergeEnvText(text, updates) {
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m) return line;
    const key = m[2];
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });

  const missing = Object.keys(updates).filter((k) => !seen.has(k));
  if (missing.length) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push("# --- 由 scripts/setup.mjs 追加 ---");
    for (const k of missing) out.push(`${k}=${updates[k]}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
}

/* ------------------------------ 输入工具 ------------------------------ */

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** 隐藏输入（密码/密钥）；非 TTY 时退回普通输入，方便管道和 agent */
function askHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return ask(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else if (ch >= " " && ch !== "\u001b") {
          value += ch;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

const mask = (v) => {
  if (!v) return "(未设置)";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
};

/* ------------------------------ 参数收集 ------------------------------ */

function parseSets() {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let pair = null;
    if (a === "--set") pair = args[++i];
    else if (a.startsWith("--set=")) pair = a.slice("--set=".length);
    if (!pair) continue;
    const j = pair.indexOf("=");
    if (j < 1) {
      console.error(`--set 参数格式不对：${pair}（应为 KEY=VALUE）`);
      process.exit(2);
    }
    out[pair.slice(0, j).trim()] = pair.slice(j + 1).trim();
  }
  return out;
}

function fromProcessEnv() {
  const out = {};
  for (const k of KNOWN_KEYS) {
    if (process.env[k] !== undefined && process.env[k] !== "") out[k] = process.env[k];
  }
  return out;
}

/* ------------------------------ 校验 ------------------------------ */

function validate(map) {
  const problems = [];
  const warns = [];

  const appid = map.get("WECHAT_APPID") ?? "";
  if (!appid) problems.push("WECHAT_APPID 未设置");
  else if (!/^wx[0-9a-f]{16}$/i.test(appid)) warns.push("WECHAT_APPID 格式不像常见的 wx + 16 位十六进制，确认没抄错");

  const secret = map.get("WECHAT_APPSECRET") ?? "";
  if (!secret) problems.push("WECHAT_APPSECRET 未设置");
  else if (!/^[a-z0-9]{32}$/i.test(secret)) warns.push("WECHAT_APPSECRET 通常为 32 位字母数字，确认没抄错或多了空格");

  if (!map.get("OPENCODE_API_KEY")) problems.push("OPENCODE_API_KEY 未设置");

  const base = map.get("OPENCODE_BASE_URL") ?? "";
  if (base && !/^https?:\/\//i.test(base)) problems.push("OPENCODE_BASE_URL 必须以 http(s):// 开头");
  if (!map.get("OPENCODE_MODEL")) warns.push("OPENCODE_MODEL 为空，将使用代码内默认值");

  if ((map.get("PUBLISH_MODE") ?? "draft") === "freepublish") {
    warns.push("PUBLISH_MODE=freepublish：个人主体公众号会被微信拒绝（48001），通常应使用 draft");
  }

  return { problems, warns };
}

function printConfig(map) {
  console.log("\n当前配置：");
  for (const k of [
    "WECHAT_APPID",
    "WECHAT_APPSECRET",
    "WECHAT_AUTHOR",
    "OPENCODE_BASE_URL",
    "OPENCODE_API_KEY",
    "OPENCODE_MODEL",
    "OPENCODE_MODEL_FAST",
    "PUBLISH_MODE",
  ]) {
    const v = map.get(k) ?? "";
    const shown = /SECRET|KEY/.test(k) ? mask(v) : v || "(空)";
    console.log(`  ${k.padEnd(22)} ${shown}`);
  }
}

/* ------------------------------ 主流程 ------------------------------ */

const sets = parseSets();
const fromEnv = has("--from-env") ? fromProcessEnv() : {};
const updates = { ...fromEnv, ...sets };

if (has("--help") || has("-h")) {
  console.log(`用法：
  node scripts/setup.mjs                交互式配置
  node scripts/setup.mjs --check        只检查现有 .env
  node scripts/setup.mjs --set K=V ...  非交互写入（可多次）
  node scripts/setup.mjs --from-env     从环境变量读取已知键
`);
  process.exit(0);
}

const baseText = fs.existsSync(ENV_PATH)
  ? fs.readFileSync(ENV_PATH, "utf8")
  : fs.existsSync(EXAMPLE_PATH)
    ? fs.readFileSync(EXAMPLE_PATH, "utf8")
    : "";

const current = parseEnv(baseText);

if (has("--check")) {
  if (!fs.existsSync(ENV_PATH)) {
    console.error("❌ 还没有 .env。先运行 npm run setup");
    process.exit(1);
  }
  const { problems, warns } = validate(current);
  printConfig(current);
  for (const w of warns) console.log(`  ⚠️  ${w}`);
  if (problems.length) {
    console.error("\n❌ 还缺这些必填项：");
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
  }
  console.log("\n✅ 必填项齐全。下一步：npm run check   （会联网验证凭证和模型）");
  process.exit(0);
}

const interactive = process.stdin.isTTY && !Object.keys(sets).length && !has("--from-env");

if (interactive) {
  console.log("\n=== wechat-daily 配置向导 ===");
  console.log("回车表示保留当前值；(current) 里显示的是已保存的值。\n");

  const get = (k) => current.get(k) ?? "";

  const appid = await ask(`公众号 AppID${get("WECHAT_APPID") ? ` [${get("WECHAT_APPID")}]` : ""}：`);
  if (appid) updates.WECHAT_APPID = appid;

  const secret = await askHidden(
    `AppSecret${get("WECHAT_APPSECRET") ? " [已设置，回车保留]" : ""}（输入不回显）：`
  );
  if (secret) updates.WECHAT_APPSECRET = secret;

  const author = await ask(`草稿箱作者名${get("WECHAT_AUTHOR") ? ` [${get("WECHAT_AUTHOR")}]` : "（可留空）"}：`);
  if (author) updates.WECHAT_AUTHOR = author;

  const key = await askHidden(
    `模型 API Key${get("OPENCODE_API_KEY") ? " [已设置，回车保留]" : "（任意 OpenAI 兼容服务）"}（输入不回显）：`
  );
  if (key) updates.OPENCODE_API_KEY = key;

  const base = await ask(`模型 Base URL [${get("OPENCODE_BASE_URL") || "https://opencode.ai/zen/go/v1"}]：`);
  if (base) updates.OPENCODE_BASE_URL = base;

  const model = await ask(`写稿模型 [${get("OPENCODE_MODEL") || "deepseek-v4.1-flash"}]：`);
  if (model) updates.OPENCODE_MODEL = model;

  const fast = await ask(`快模型（选题/自检/看图，留空=同上）[${get("OPENCODE_MODEL_FAST") || "同上"}]：`);
  if (fast) updates.OPENCODE_MODEL_FAST = fast;
}

if (Object.keys(updates).length === 0 && !fs.existsSync(ENV_PATH)) {
  console.error("\n没有任何配置被写入。用 --set KEY=VALUE 或在终端里交互式运行。");
  process.exit(2);
}

// 只把用户真正提供的值写进去；空字符串不覆盖已有值（除非显式 --set K=）
const clean = {};
for (const [k, v] of Object.entries(updates)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
    console.error(`忽略非法变量名：${k}`);
    continue;
  }
  if (v !== "") clean[k] = v;
}

const merged = mergeEnvText(baseText, clean);

if (fs.existsSync(ENV_PATH)) {
  const backup = `${ENV_PATH}.bak`;
  fs.copyFileSync(ENV_PATH, backup);
  try {
    fs.chmodSync(backup, 0o600);
  } catch {}
}
fs.writeFileSync(ENV_PATH, merged, { mode: 0o600 });
try {
  fs.chmodSync(ENV_PATH, 0o600);
} catch {
  // Windows 上没有 POSIX 权限位，忽略
}

const after = parseEnv(merged);
printConfig(after);

const { problems, warns } = validate(after);
for (const w of warns) console.log(`  ⚠️  ${w}`);

if (problems.length) {
  console.error("\n还缺这些必填项，补完就能跑：");
  for (const p of problems) console.error(`   - ${p}`);
  console.error("\n可以重新运行 node scripts/setup.mjs --set KEY=VALUE");
  process.exit(1);
}

console.log(`
✅ 已写入 ${path.relative(process.cwd(), ENV_PATH) || ".env"}

下一步（按顺序）：
  1. npm run whitelist      # 让微信告诉你该把哪个出口 IP 加进白名单
  2. npm run check          # 联网自检：模型 / 封面 / 排版 / 凭证
  3. npm run dry            # 只生成不发：data/out/<今天>/
  4. npm run daily          # 生成并进草稿箱，然后去手机上点群发

提示：个人主体公众号只能进草稿箱，PUBLISH_MODE=draft 是对的。
`);
