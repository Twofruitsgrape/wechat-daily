#!/usr/bin/env node
/**
 * 本地预览：把 markdown 渲染成和微信里几乎一样的排版，
 * 生成一个可以在浏览器里看的 HTML（手机宽度），不发任何请求。
 *
 *   node src/tools/preview.js data/out/2026-10-29/article.md
 *   node src/tools/preview.js data/out/2026-10-29/article.md --open
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { ROOT, loadEnv } from "../env.js";
import { readYaml, ensureDir } from "../util.js";
import { renderWechat } from "../render.js";

loadEnv();
const args = process.argv.slice(2);
const mdPath = args.find((a) => !a.startsWith("--"));
if (!mdPath) {
  console.error("用法：node src/tools/preview.js <markdown 文件> [--open]");
  process.exit(1);
}
const abs = path.isAbsolute(mdPath) ? mdPath : path.join(process.cwd(), mdPath);
if (!fs.existsSync(abs)) {
  console.error(`找不到文件：${abs}`);
  process.exit(1);
}

const site = readYaml("config/site.yaml");
const md = fs.readFileSync(abs, "utf8");
const { html } = renderWechat(md, site.theme ?? {});

const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(abs)).trim();

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览 · ${title}</title>
<style>
  body{margin:0;background:#ededed;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;}
  .phone{max-width:420px;margin:24px auto;background:#fff;border-radius:8px;box-shadow:0 2px 16px rgba(0,0,0,.08);overflow:hidden;}
  .bar{padding:14px 18px 4px;font-size:20px;font-weight:700;color:#1a1a1a;line-height:1.4;}
  .meta{padding:0 18px 12px;font-size:12px;color:#9a9a9a;border-bottom:1px solid #f0f0f0;}
  .content{padding:16px 18px 28px;}
  img{max-width:100%;}
</style></head>
<body>
  <div class="phone">
    <div class="bar">${title.replace(/[<>&]/g, "")}</div>
    <div class="meta">${new Date().toLocaleString("zh-CN")} · 本地预览</div>
    <div class="content">${html}</div>
  </div>
</body></html>`;

const out = path.join(path.dirname(abs), "preview.html");
ensureDir(path.dirname(out));
fs.writeFileSync(out, page, "utf8");
console.log(`预览已生成：${out}`);
console.log(`大小：${(page.length / 1024).toFixed(0)}KB，正文 ${md.length} 字符`);

if (args.includes("--open")) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [out], () => {});
  console.log("已在浏览器中打开");
}
