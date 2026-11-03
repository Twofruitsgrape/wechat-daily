#!/usr/bin/env node
/**
 * IP 白名单自动发现
 *
 *   node src/tools/whitelist.js            默认探测 15 次
 *   node src/tools/whitelist.js --times=40
 *
 * 背景：很多机器（校园网 / 公司 NAT / 多线路）的出口 IP 不止一个，而且会按目的地
 * 分流到不同链路。所以「本机出口 IP 是多少」没有统一答案——只有微信自己知道它看到的是哪个。
 *
 * 办法：反复打 stable_token，从 40164 的 errmsg 里把微信看到的 IP 读出来。
 *   - 如果只出现一个 IP  -> 白名单填这一个就行，稳定
 *   - 如果出现多个 IP    -> 全填上；数量太多就要考虑固定 IP 中转
 *   - 如果直接成功         -> 已经配好了
 */

import { loadEnv, env } from "../env.js";

loadEnv();

const timesArg = process.argv.find((a) => a.startsWith("--times="));
const TIMES = timesArg ? Number(timesArg.split("=")[1]) : 15;

const APPID = env("WECHAT_APPID");
const SECRET = env("WECHAT_APPSECRET");

if (!APPID || !SECRET) {
  console.error("需要先配置 WECHAT_APPID 和 WECHAT_APPSECRET（.env）");
  console.error("AppSecret 在 公众平台 → 设置与开发 → 基本配置 → 开发者密码");
  process.exit(1);
}

console.log(`\n对 api.weixin.qq.com 探测 ${TIMES} 次，看它认为我们来自哪个 IP…\n`);

const seen = new Map(); // ip -> count
let okCount = 0;
let otherError = null;

for (let i = 1; i <= TIMES; i++) {
  try {
    const res = await fetch("https://api.weixin.qq.com/cgi-bin/stable_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credential",
        appid: APPID,
        secret: SECRET,
        force_refresh: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();

    if (!data.errcode) {
      okCount++;
      process.stdout.write(".");
      continue;
    }
    if (data.errcode === 40164) {
      const ip = String(data.errmsg).match(/invalid ip\s+([\d.]+)/i)?.[1];
      if (ip) {
        seen.set(ip, (seen.get(ip) || 0) + 1);
        process.stdout.write("·");
      } else {
        process.stdout.write("?");
        otherError = data;
      }
      continue;
    }
    // 40125 / 40001 等：AppSecret 本身有问题，继续测没意义
    otherError = data;
    break;
  } catch (err) {
    otherError = { errcode: "network", errmsg: err.message };
    process.stdout.write("x");
  }
  await new Promise((r) => setTimeout(r, 800));
}

console.log("\n");

if (okCount > 0) {
  console.log(`✅ 有 ${okCount} 次调用成功 —— token 已经能拿到，说明白名单已配好。`);
  if (seen.size) {
    console.log(`   （另有 ${[...seen.values()].reduce((a, b) => a + b, 0)} 次被 40164 拦下，IP 见下）`);
  }
}

if (seen.size === 0 && okCount === 0) {
  console.log("❌ 没有拿到有效结果。微信返回：");
  console.log("   ", JSON.stringify(otherError));
  if (otherError?.errcode === 40125 || otherError?.errcode === 40001) {
    console.log("\n   → AppSecret 不正确，先去公众平台确认开发者密码。");
  }
  process.exit(1);
}

if (seen.size > 0) {
  const rows = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  console.log("微信看到的出口 IP：\n");
  for (const [ip, n] of rows) {
    console.log(`   ${ip.padEnd(18)} ${n} 次`);
  }
  console.log("\n把上面这些 IP 全部填进：");
  console.log("   公众平台 → 设置与开发 → 基本配置 → IP白名单 → 修改\n");
  console.log("可直接复制的列表：");
  for (const [ip] of rows) console.log(ip);

  if (rows.length === 1) {
    console.log("\n结论：出口 IP 对微信是稳定的，配这一个就够了。");
  } else if (rows.length <= 4) {
    console.log(`\n结论：有 ${rows.length} 个出口 IP 在用，全部填进去即可（公众号白名单支持多个）。`);
  } else {
    console.log(`\n结论：出口 IP 有 ${rows.length} 个且在轮换，白名单填不全。`);
    console.log("      建议改用固定出口 IP 的中转（自建小 VPS 反向代理到 api.weixin.qq.com）。");
  }
}
console.log("");
