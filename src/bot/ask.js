#!/usr/bin/env node
/**
 * 每天 09:00 由 systemd timer 调用：主动问你今天写什么。
 *
 *   node src/bot/ask.js
 *   node src/bot/ask.js --force     正在写的时候也强行问
 *
 * 这是独立进程，所以要自己建一条短连接：连上 → 发一条 → 断开。
 * （常驻的 aibot.js 负责收消息和写完之后的通知）
 */

import { WSClient } from "@wecom/aibot-node-sdk";

import { loadEnv, env } from "../env.js";
import { dateInTZ } from "../util.js";
import { loadBotState, setPhase } from "./state.js";
import { lastChatId } from "./channel.js";

loadEnv();

const FORCE = process.argv.includes("--force");
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const BOT_ID = env("WECOM_BOT_ID");
const BOT_SECRET = env("WECOM_BOT_SECRET");

if (!BOT_ID || !BOT_SECRET) {
  log("缺少 WECOM_BOT_ID / WECOM_BOT_SECRET，跳过");
  process.exit(0);
}

const state = loadBotState();
const today = dateInTZ("Asia/Shanghai");

if (state.phase === "generating" && !FORCE) {
  log("正在生成中，不打扰");
  process.exit(0);
}
if (state.phase === "awaiting_topic" && state.date === today && !FORCE) {
  log("今天已经问过了，跳过（--force 可强制再问）");
  process.exit(0);
}

const chatid = lastChatId();
if (!chatid) {
  log("还没有会话记录：需要你先在企业微信里给机器人发一条消息");
  process.exit(2);
}

const prompt = `**早上好，今天写点什么？**

直接回一段话就行 —— 那就是选题 + 要求，例如：
> 余热回收里最常见的估算错误，要举一个手算例子

也可以这样分开：
> 主题 | 额外要求

发「帮助」看全部指令，发「状态」看我的进度。`;

const ws = new WSClient({ botId: BOT_ID, secret: BOT_SECRET });

let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  try {
    ws.disconnect();
  } catch {}
  setTimeout(() => process.exit(code), 200);
};

const timer = setTimeout(() => {
  log("连接超时（30s）");
  finish(1);
}, 30_000);

ws.on("authenticated", async () => {
  try {
    await ws.sendMessage(chatid, {
      msgtype: "markdown",
      markdown: { content: prompt },
    });
    log(`已向 ${chatid} 发出 ${today} 的选题询问`);
    setPhase("awaiting_topic", { date: today, askedAt: new Date().toISOString() });
    clearTimeout(timer);
    finish(0);
  } catch (err) {
    log(`发送失败：${err.message}`);
    clearTimeout(timer);
    finish(1);
  }
});

ws.on("error", (err) => {
  log(`连接错误：${err?.message ?? err}`);
});

log("正在建立长连接…");
ws.connect();
