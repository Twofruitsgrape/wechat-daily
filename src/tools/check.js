#!/usr/bin/env node
/**
 * 自检脚本：把整条链路上最容易出问题的地方逐个验一遍。
 *   node src/tools/check.js
 * 只做只读操作，不会往公众号里写任何东西。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ROOT, loadEnv, env } from "../env.js";
import { dateInTZ } from "../util.js";
import { chat, modelFor } from "../llm.js";
import { renderCover } from "../cover.js";
import { renderWechat } from "../render.js";
import { probeCredentials, detectEgressIp } from "../wechat.js";

loadEnv();

const ok = (m) => console.log(`  ✅ ${m}`);
let failures = 0;
const bad = (m) => {
  failures += 1;
  console.log(`  ❌ ${m}`);
};
const warn = (m) => console.log(`  ⚠️  ${m}`);

console.log("\n=== 1. 运行环境 ===");
ok(`Node ${process.version}  ${os.platform()} ${os.arch()}`);
ok(`项目目录 ${ROOT}`);
for (const f of ["config/site.yaml", "config/topics.yaml", ".env"]) {
  fs.existsSync(path.join(ROOT, f)) ? ok(`${f} 存在`) : warn(`${f} 缺失`);
}

console.log("\n=== 2. 模型（OpenAI 兼容）===");
console.log(`  Base URL   : ${env("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1")}`);
console.log(`  写稿       : ${env("OPENCODE_MODEL", "deepseek-v4.1-flash")}`);
console.log(`  选题/看图  : ${env("OPENCODE_MODEL_FAST") || env("OPENCODE_MODEL", "deepseek-v4.1-flash")}`);
console.log(`  视觉       : ${env("PAPER_VISION_MODEL", "deepseek-v4.1-flash")}`);
console.log(`  对话 agent : ${env("PI_MODEL", "opencode-go/deepseek-v4.1-flash")}  thinking=${env("PI_THINKING", "auto")}`);
try {
  const r = await chat({
    model: modelFor("fast"),
    maxTokens: 60,
    temperature: 0,
    tag: "check",
    messages: [{ role: "user", content: "只回复两个字：可用" }],
  });
  ok(`${r.model} 可用，返回：${r.content.trim().slice(0, 20)}`);
} catch (e) {
  bad(`模型调用失败：${e.message}`);
}

console.log("\n=== 3. 封面渲染 ===");
try {
  const tmp = path.join(ROOT, "data", "tmp", "check-cover.png");
  const c = await renderCover({
    title: "余热驱动MVR蒸发系统的估算陷阱",
    date: dateInTZ("Asia/Shanghai"),
    kicker: "每日一篇",
    brand: "测试",
    theme: "auto",
    out: tmp,
  });
  const size = fs.statSync(c.path).size;
  ok(`${c.width}x${c.height} 主题=${c.theme} 字号=${c.fontSize} ${(size / 1024).toFixed(0)}KB -> ${path.relative(ROOT, c.path)}`);
} catch (e) {
  bad(`封面渲染失败：${e.message}`);
}

console.log("\n=== 4. 排版 ===");
try {
  const demo = `## 小标题测试\n\n这一段有**加粗**、*斜体*、\`行内代码\`，还有一个[外链](https://example.com/x)。\n\n- 列表项一\n- 列表项二\n  - 嵌套项\n\n1. 有序一\n2. 有序二\n\n> 引用块测试\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n`;
  const { html, footnotes } = renderWechat(demo, {});
  const leaks = [];
  if (/<script/i.test(html)) leaks.push("script 标签");
  if (/\sclass=/.test(html)) leaks.push("class 属性（微信会剥掉）");
  if (/<style/i.test(html)) leaks.push("style 标签（微信会剥掉）");
  ok(`HTML ${html.length} 字符，外链 ${footnotes.length} 个收进文末`);
  if (leaks.length) bad(`发现微信不支持的结构：${leaks.join(", ")}`);
  else ok("无 script/class/style 标签，可直接进草稿箱");
} catch (e) {
  bad(`排版失败：${e.message}`);
}

console.log("\n=== 5. 出口 IP（要填进公众号 IP 白名单）===");
const ips = await detectEgressIp();
if (ips.length) ips.forEach((ip) => ok(ip));
else warn("探测不到出口 IP（网络受限？）");
if (ips.length > 1) warn("探测到多个出口 IP —— 多线路 NAT / 代理环境，建议把全部 IP 都加进白名单");

console.log("\n=== 6. 微信公众号凭证 ===");
if (!env("WECHAT_APPSECRET")) {
  bad("WECHAT_APPSECRET 未配置（公众平台 → 设置与开发 → 基本配置 → 开发者密码）");
} else {
  const r = await probeCredentials();
  if (r.ok) ok(`AppID/AppSecret 有效，token 尾号 ${r.tokenTail}`);
  else bad(`凭证不可用：${r.error}`);
}

console.log("\n=== 7. 发布模式 ===");
const mode = env("PUBLISH_MODE", "draft");
if (mode === "draft") ok("draft：只进草稿箱，手机端人工点群发（个人主体的正确选择）");
else warn(`freepublish：直接发表。个人主体账号 2025-07 起已被回收此权限，调用会报 48001`);

console.log("");
if (failures) {
  console.log(`自检有 ${failures} 项失败。按上面的 ❌ 逐项处理；不确定就先看 docs/TROUBLESHOOTING.md`);
  process.exit(1);
}
console.log("✅ 自检通过");
