#!/usr/bin/env node
/**
 * 离线自检：不联网、不碰微信、不调用模型。
 *
 *   node scripts/selftest.mjs
 *
 * 验证四件事：
 *   1. Node 版本和配置文件语法
 *   2. 排版渲染不会产生微信会剥掉的标签
 *   3. 封面图能真的渲染出来（sharp + 中文字体）
 *   4. 仓库里没有误提交的密钥 / 个人路径
 *
 * CI 和「刚解压完项目」都适合先跑这个。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readYaml } from "../src/util.js";
import { renderWechat } from "../src/render.js";
import { renderCover } from "../src/cover.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");;

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  failures.push(m);
  console.log(`  ❌ ${m}`);
};
const warn = (m) => console.log(`  ⚠️  ${m}`);
const failures = [];

console.log("\n=== 1. 运行环境 ===");
const major = Number(process.version.replace(/^v/, "").split(".")[0]);
if (major >= 20) ok(`Node ${process.version}`);
else bad(`Node ${process.version} 太旧，需要 >= 20`);

for (const f of ["config/site.yaml", "config/topics.yaml", ".env.example"]) {
  fs.existsSync(path.join(ROOT, f)) ? ok(`${f} 存在`) : bad(`${f} 缺失`);
}

let site;
try {
  site = readYaml("config/site.yaml");
  const topics = readYaml("config/topics.yaml");
  ok(`site.yaml 可解析（theme=${site.theme?.font_size ?? "?"}px，timezone=${site.timezone ?? "?"}）`);
  ok(`topics.yaml 可解析（domain=${topics.domain ?? "空"}）`);
  if (!site.theme || !site.style) warn("site.yaml 缺少 theme/style，会退回默认值");
} catch (e) {
  bad(`配置文件解析失败：${e.message}`);
}

console.log("\n=== 2. 排版引擎 ===");
try {
  const demo = [
    "# 测试标题",
    "",
    "这是一段正文，包含**加粗**、*斜体*、`行内代码`，以及一个[外链](https://example.com/x)。",
    "",
    "## 01 小标题",
    "",
    "==这是重点句==，应该被渲染成彩色。",
    "",
    "- 列表项一",
    "- 列表项二",
    "",
    "1. 有序一",
    "2. 有序二",
    "",
    "> 引用块",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "| 列A | 列B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "![图1 测试](data/out/test/a.png)",
    "",
    "> 图 1：测试图注",
  ].join("\n");
  const { html, footnotes } = renderWechat(demo, site.theme ?? {});
  if (!html || html.length < 300) bad(`HTML 输出异常（${html?.length ?? 0} 字符）`);
  else ok(`HTML ${html.length} 字符`);
  if (footnotes.length) ok(`外链已收进文末（${footnotes.length} 个）`);
  else warn("外链没有进文末（link_mode 可能不是 text）");
  const leaks = [
    [/<script/i, "script 标签"],
    [/\sclass=/, "class 属性"],
    [/<style/i, "style 标签"],
    [/\sid=/, "id 属性"],
  ]
    .filter(([re]) => re.test(html))
    .map(([, name]) => name);
  if (leaks.length) bad(`微信会剥掉的结构：${leaks.join(", ")}`);
  else ok("没有 script/class/style/id");
  if (!/style="/.test(html)) bad("样式没有内联，粘贴到微信会变成纯文本");
  else ok("样式已内联");
} catch (e) {
  bad(`排版失败：${e.message}`);
}

console.log("\n=== 3. 封面渲染 ===");
try {
  const out = path.join(ROOT, "data", "tmp", "selftest-cover.png");
  const c = await renderCover({
    title: "离线自检：封面能否渲染",
    date: "2025-01-01",
    kicker: site.cover?.kicker ?? "每日一篇",
    brand: site.account?.name ?? "",
    theme: "auto",
    out,
  });
  const kb = fs.statSync(c.path).size / 1024;
  if (c.width === (site.cover?.width ?? 900) && c.height === (site.cover?.height ?? 383)) {
    ok(`${c.width}x${c.height} PNG ${kb.toFixed(0)}KB（主题 ${c.theme}）`);
  } else {
    bad(`封面尺寸不对：${c.width}x${c.height}`);
  }
  if (kb < 5) bad("封面文件小得可疑，可能没渲染出字");
  fs.rmSync(out, { force: true });
} catch (e) {
  bad(`封面渲染失败：${e.message}（Linux 上需要中文字体，见 README）`);
}

console.log("\n=== 4. 配置完整性 ===");
const envPath = path.join(ROOT, ".env");
if (!fs.existsSync(envPath)) {
  warn("还没有 .env —— 跑 npm run setup 生成");
} else {
  const text = fs.readFileSync(envPath, "utf8");
  const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  const missing = ["WECHAT_APPID", "WECHAT_APPSECRET", "OPENCODE_API_KEY"].filter((k) => !get(k));
  if (missing.length) warn(`.env 里还缺：${missing.join(", ")}`);
  else ok(".env 必填项齐全");
}

console.log("\n=== 5. 密钥扫描（防止开源时误提交）===");
const SKIP_DIRS = new Set(["node_modules", ".git", "data", ".github"]);
const TEXT_EXT = /\.(js|mjs|cjs|json|yaml|yml|md|sh|txt|example)$|^\.env\.example$/;
const PATTERNS = [
  [/wx[0-9a-f]{16}\b/i, "疑似真实 AppID"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/sk-[A-Za-z0-9]{24,}/, "API key"],
  [/\/home\/(?!user\b|your\b)[a-z0-9_-]+\//i, "个人主目录路径"],
  [/[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net/i, "个人 Tailscale 域名"],
];
const hits = [];

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") && ent.name !== ".env.example") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(p);
      continue;
    }
    if (!TEXT_EXT.test(ent.name)) continue;
    const rel = path.relative(ROOT, p).replaceAll("\\", "/");
    if (rel === ".env" || rel.endsWith(".bak")) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, label] of PATTERNS) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} ${label}`);
      }
    });
  }
}

try {
  walk(ROOT);
  if (hits.length) {
    for (const h of hits) bad(h);
  } else {
    ok("没有发现真实密钥 / 个人路径");
  }
} catch (e) {
  warn(`扫描跳过：${e.message}`);
}

console.log("");
if (failures.length) {
  console.error(`❌ 自检失败（${failures.length} 项）`);
  process.exit(1);
}
console.log("✅ 离线自检通过。下一步：npm run setup 然后 npm run check");
