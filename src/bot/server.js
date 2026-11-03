#!/usr/bin/env node
/* 【未使用】自建应用 + 回调 URL 方案。企业微信要求回调域名必须
   备案主体与企业主体一致，个人注册的企业微信没有备案域名，
   已改用智能机器人长连接（src/bot/aibot.js）。留作将来有备案域名时的备选。*/
/**
 * 企业微信回调服务器 + 指令分发
 *
 *   node src/bot/server.js            正常启动
 *   node src/bot/server.js --port=8899
 *
 * 只监听 127.0.0.1，公网入口交给 Tailscale Funnel 转发，
 * 这样即使 Funnel 配错也不会把服务直接暴露在校园网里。
 */

import http from "node:http";

import { loadEnv, env } from "../env.js";
import { verifySignature, decrypt, xmlField } from "./crypto.js";
import { wecomConfig, sendText, isConfigured } from "./client.js";
import { loadBotState, setPhase, isDuplicateMsg } from "./state.js";
import { startPipeline, pipelineRunning } from "./runner.js";

loadEnv();

const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT = Number(portArg?.split("=")[1] ?? env("BOT_PORT", "8899"));
const HOST = "127.0.0.1";

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const HELP = `我可以帮你每天写一篇公众号文章。

直接发一段话，我就把它当成今天的选题和要求，例如：
  余热回收里最常见的估算错误，要举一个手算例子

也可以用竖线分隔主题和要求：
  余热回收估算错误 | 要具体到手算，结尾给检查清单

其他指令：
  状态  —— 看现在在干什么
  重写  —— 按今天的选题再来一版（可跟新要求）
  取消  —— 放弃今天这次
  帮助  —— 显示这段说明`;

/* ------------------------------ 业务分发 ------------------------------ */
async function handleText({ fromUser, content, msgId }) {
  const { allowedUsers } = wecomConfig();
  if (allowedUsers.length && !allowedUsers.includes(fromUser)) {
    log(`拒绝非授权用户：${fromUser}`);
    return;
  }
  if (isDuplicateMsg(msgId)) {
    log(`重复消息，忽略 MsgId=${msgId}`);
    return;
  }

  const text = String(content ?? "").trim();
  if (!text) return;
  log(`收到 ${fromUser}: ${text.slice(0, 80)}`);

  const state = loadBotState();

  /* 控制指令 */
  if (/^(帮助|help|\?|？)$/i.test(text)) {
    return sendText(HELP, { toUser: fromUser });
  }

  if (/^(状态|status)$/i.test(text)) {
    if (state.phase === "generating") {
      const mins = state.startedAt ? Math.round((Date.now() - Date.parse(state.startedAt)) / 60000) : null;
      return sendText(
        `✍️ 正在写：${state.topic}\n已进行 ${mins ?? "?"} 分钟，完成后我叫你。`,
        { toUser: fromUser }
      );
    }
    if (state.lastSummary) return sendText(`上一次的结果：\n\n${state.lastSummary}`, { toUser: fromUser });
    return sendText("现在空闲。发一段话给我，我就开始写。", { toUser: fromUser });
  }

  if (/^(取消|cancel)$/i.test(text)) {
    setPhase("idle");
    return sendText("已取消。下次要写直接发选题给我。", { toUser: fromUser });
  }

  if (pipelineRunning()) {
    return sendText(`正在写「${state.topic}」，写完再发新的。要放弃这次就发「取消」。`, { toUser: fromUser });
  }

  /* 重写：沿用上次选题 */
  const redo = text.match(/^(重写|重做|redo)\s*([\s\S]*)$/i);
  if (redo) {
    const topic = state.topic || "";
    if (!topic) return sendText("还没有可重写的选题，先发一个给我。", { toUser: fromUser });
    const extra = redo[2]?.trim() ?? "";
    const brief = [state.brief, extra].filter(Boolean).join("\n");
    await sendText(`收到，按「${topic}」再来一版${extra ? `，额外要求：${extra}` : ""}。约 6-8 分钟。`, {
      toUser: fromUser,
    });
    startPipeline({ topic, brief, force: true, toUser: fromUser });
    return;
  }

  /* 默认：这段文字就是选题 + 要求 */
  const [topicPart, briefPart] = splitTopicBrief(text);
  const topic = topicPart.slice(0, 120);
  const brief = text.length > topicPart.length ? text : briefPart || "";

  await sendText(
    `收到，开始写：\n\n「${topic}」\n\n约 6-8 分钟，写完进草稿箱后我立刻叫你。`,
    { toUser: fromUser }
  );
  startPipeline({ topic, brief, force: true, toUser: fromUser });
}

/** 支持「主题 | 要求」分隔；没有分隔符就整段当主题 */
function splitTopicBrief(text) {
  const m = text.match(/^([^|｜\n]{2,120})\s*[|｜]\s*([\s\S]+)$/);
  if (m) return [m[1].trim(), m[2].trim()];
  return [text.trim(), ""];
}

/* ------------------------------ HTTP ------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cfg = wecomConfig();

  if (url.pathname === "/healthz") {
    const s = loadBotState();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: true,
        configured: isConfigured(),
        phase: s.phase,
        topic: s.topic,
        date: s.date,
        uptime: process.uptime(),
      })
    );
  }

  if (url.pathname !== "/wecom") {
    res.writeHead(404).end("not found");
    return;
  }

  /* ① 配置回调 URL 时企业微信会发 GET 来验证 */
  if (req.method === "GET") {
    const q = url.searchParams;
    const ok = verifySignature({
      token: cfg.token,
      timestamp: q.get("timestamp"),
      nonce: q.get("nonce"),
      encrypted: q.get("echostr"),
      msgSignature: q.get("msg_signature"),
    });
    if (!ok) {
      log("GET 验证：签名不匹配");
      res.writeHead(401).end("bad signature");
      return;
    }
    try {
      const { message, receiveId } = decrypt(cfg.aesKey, q.get("echostr"));
      if (cfg.corpId && receiveId && receiveId !== cfg.corpId) {
        log(`GET 验证：receiveid 不匹配（${receiveId} != ${cfg.corpId}）`);
        res.writeHead(401).end("bad receiveid");
        return;
      }
      log("GET 验证通过");
      res.writeHead(200, { "Content-Type": "text/plain" }).end(message);
    } catch (err) {
      log(`GET 验证解密失败：${err.message}`);
      res.writeHead(500).end("decrypt failed");
    }
    return;
  }

  /* ② 接收消息 */
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // 先回 200，避免企业微信 5 秒超时重试；处理逻辑异步跑
      res.writeHead(200, { "Content-Type": "text/plain" }).end("");

      try {
        const encrypted = xmlField(body, "Encrypt");
        const q = url.searchParams;
        const ok = verifySignature({
          token: cfg.token,
          timestamp: q.get("timestamp"),
          nonce: q.get("nonce"),
          encrypted,
          msgSignature: q.get("msg_signature"),
        });
        if (!ok) {
          log("POST：签名不匹配，丢弃");
          return;
        }
        const { message } = decrypt(cfg.aesKey, encrypted);
        const msgType = xmlField(message, "MsgType");
        const fromUser = xmlField(message, "FromUserName");
        const msgId = xmlField(message, "MsgId");
        const content = xmlField(message, "Content");

        if (msgType !== "text") {
          log(`忽略非文本消息：${msgType}`);
          return;
        }
        handleText({ fromUser, content, msgId }).catch((err) => log(`处理失败：${err.stack || err.message}`));
      } catch (err) {
        log(`POST 解析失败：${err.message}`);
      }
    });
    return;
  }

  res.writeHead(405).end("method not allowed");
});

server.listen(PORT, HOST, () => {
  log(`企业微信回调服务已启动 http://${HOST}:${PORT}/wecom`);
  log(`配置状态：${isConfigured() ? "已配置" : "缺少 WECOM_* 环境变量"}`);
  log(`健康检查：http://${HOST}:${PORT}/healthz`);
});

process.on("SIGTERM", () => {
  log("收到 SIGTERM，退出");
  server.close(() => process.exit(0));
});
