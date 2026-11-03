#!/usr/bin/env node
/**
 * 企业微信「智能机器人」长连接入口
 *
 *   node src/bot/aibot.js
 *
 * 为什么用长连接而不是自建应用回调：
 *   自建应用的「接收消息」URL 必须是**备案主体与企业主体一致**的域名
 *   （官方帮助文档明确要求，个人注册的企业微信没有备案域名，填 IP 也会被拒）。
 *   智能机器人的长连接是本地主动连到 wss://openws.work.weixin.qq.com，
 *   官方文档原话：「不受企业域名或IP限制」「无需固定的公网 IP」「无需加解密」。
 *
 * 需要 .env 里的 WECOM_BOT_ID 和 WECOM_BOT_SECRET（不是自建应用那套 CorpID）。
 */

import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import fs from "node:fs";
import path from "node:path";

import { loadEnv, env, ROOT } from "../env.js";
import { ensureDir } from "../util.js";
import { handleUserText, isAllowed } from "./dispatch.js";
import { setClient, rememberChat } from "./channel.js";
import { startPipeline, pipelineRunning } from "./runner.js";

loadEnv();

const BOT_ID = env("WECOM_BOT_ID");
const BOT_SECRET = env("WECOM_BOT_SECRET");

if (!BOT_ID || !BOT_SECRET) {
  console.error("缺少 WECOM_BOT_ID / WECOM_BOT_SECRET");
  console.error("在企业微信里：工作台 → 智能机器人 → 创建机器人 → 手动创建 → API 模式 → 使用长连接");
  process.exit(1);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const ws = new WSClient({ botId: BOT_ID, secret: BOT_SECRET });
setClient(ws);

ws.on("authenticated", () => {
  log("🔐 长连接认证成功，机器人已就绪");
});

/* 文本消息 */
ws.on("message.text", async (frame) => {
  const body = frame.body ?? {};
  const text = body.text?.content ?? "";
  const userid = body.from?.userid ?? "";

  // 记下会话，9:00 主动问候和完成通知都要用它
  rememberChat({ chatid: body.chatid, userid });

  // 被动回复：必须在收到消息后尽快回
  const send = (s) => ws.replyStream(frame, generateReqId("stream"), s, true);

  if (!isAllowed(userid)) {
    log(`拒绝非授权用户 ${userid}`);
    return send("抱歉，这个机器人只对指定的账号开放。").catch(() => {});
  }

  try {
    await handleUserText({ text, userid, msgId: body.msgid, send });
  } catch (err) {
    log(`处理失败：${err.stack || err.message}`);
    await send(`出错了：${err.message}`).catch(() => {});
  }
});

/* 全量帧日志：任何服务端推送都记下来，排查时救命 */
ws.on("message", (frame) => {
  const b = frame?.body ?? {};
  log(
    `📥 收到消息帧 msgtype=${b.msgtype} from=${b.from?.userid ?? "?"} 字段=${Object.keys(b).join(",")}`
  );
});

ws.on("event", (frame) => {
  const b = frame?.body ?? {};
  log(`📥 收到事件帧 ${b.event?.event_type ?? JSON.stringify(b).slice(0, 100)}`);
});

ws.on("event.disconnected_event", () => log("服务端主动断开了当前长连接（可能别处新连了一条）"));

/* 用户发来文件（论文 PDF）*/
ws.on("message.file", async (frame) => {
  const body = frame.body ?? {};
  const userid = body.from?.userid ?? "";
  rememberChat({ chatid: body.chatid, userid });

  const send = (s) => ws.replyStream(frame, generateReqId("stream"), s, true);

  if (!isAllowed(userid)) return send("抱歉，这个机器人只对指定账号开放。").catch(() => {});
  if (pipelineRunning()) {
    return send("现在有一篇在写，等它完了再把 PDF 发我。想插队就发「取消」。").catch(() => {});
  }

  try {
    await send("收到文件，正在下载解密…");
    const { buffer, filename } = await ws.downloadFile(body.file?.url, body.file?.aeskey);

    // 靠文件头判断，微信不一定会给我们原始文件名
    const isPdf = buffer.subarray(0, 5).toString("latin1") === "%PDF-";
    if (!isPdf) {
      return send(
        `这个文件不是 PDF（${(buffer.length / 1024).toFixed(0)}KB）。\n目前只支持发论文 PDF 给我。`
      );
    }

    const inbox = ensureDir(path.join(ROOT, "data", "inbox"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const pdfPath = path.join(inbox, `${stamp}.pdf`);
    fs.writeFileSync(pdfPath, buffer);
    log(`收到论文 PDF：${path.relative(ROOT, pdfPath)} ${(buffer.length / 1024).toFixed(0)}KB`);

    await send(
      `已收到论文（${(buffer.length / 1024 / 1024).toFixed(2)}MB${filename ? `，${filename}` : ""}）。\n\n` +
        `正在读原文、抽图、写解读稿，预计 8-12 分钟。写完进草稿箱后我立刻叫你。`
    );

    startPipeline({ fromPaper: pdfPath, force: true });
  } catch (err) {
    log(`处理文件失败：${err.stack || err.message}`);
    await send(`处理文件失败：${err.message}`).catch(() => {});
  }
});

/* 用户刚打开机器人会话 */
ws.on("event.enter_chat", (frame) => {
  log("有人进入了会话");
  ws.replyWelcome(frame, {
    msgtype: "text",
    text: {
      content:
        "你好，我是写作助手。\n\n发一段话给我，就是今天的选题和要求，我会写完整篇并放进公众号草稿箱。\n\n发「帮助」看全部指令。",
    },
  }).catch(() => {});
});

/* 连接异常时不要静默，日志里要看得见 */
ws.on("error", (err) => log(`连接错误：${err?.message ?? err}`));

ws.connect();
log(`正在连接企业微信长连接… botId=${BOT_ID.slice(0, 8)}…`);

const shutdown = (sig) => {
  log(`收到 ${sig}，断开连接`);
  try {
    ws.disconnect();
  } catch {}
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
