/**
 * 消息通道：持有智能机器人客户端，提供「主动推送」能力。
 *
 * 被动回复（replyStream）只能在收到消息的瞬间用，9:00 主动问候和
 * 写完之后的通知都得靠主动推送，所以要把最近一次会话 ID 记下来。
 *
 * 单聊时 chatid 就是对方 userid（SDK 文档：单聊填用户的 userid）。
 */

import { loadBotState, saveBotState } from "./state.js";

let client = null;
let log = console.log;

export function setClient(c) {
  client = c;
}
export function setLogger(fn) {
  log = fn;
}
export function isReady() {
  return Boolean(client?.isConnected);
}

/** 记住最近一次交互的会话，主动推送要用 */
export function rememberChat({ chatid, userid }) {
  const s = loadBotState();
  const id = chatid || userid;
  if (id && s.lastChatId !== id) {
    s.lastChatId = id;
    s.lastChatType = chatid ? "group" : "single";
    saveBotState(s);
  }
  return id;
}

export function lastChatId() {
  return loadBotState().lastChatId ?? null;
}

/** 主动发一张本地图片给用户（agent 的 outbox 用） */
export async function sendImage(filePath, o = {}) {
  const chatid = o.chatid || lastChatId();
  if (!chatid) throw new Error("还没有可推送的会话");
  if (!client?.isConnected) throw new Error("机器人长连接未连通");

  const fs = await import("node:fs");
  const path = await import("node:path");
  const buffer = fs.readFileSync(filePath);
  const up = await client.uploadMedia(buffer, {
    type: "image",
    filename: path.basename(filePath),
  });
  const mediaId = up?.media_id || up?.mediaId;
  if (!mediaId) throw new Error(`上传图片没拿到 media_id：${JSON.stringify(up).slice(0, 200)}`);

  await client.sendMediaMessage(chatid, "image", mediaId);
  log(`[channel] 已发送图片 ${filePath.split("/").pop()}`);
  return { ok: true };
}

/**
 * 主动推送 Markdown。
 * @param {string} content
 * @param {object} [o]
 */
export async function sendProactive(content, o = {}) {
  const chatid = o.chatid || lastChatId();
  if (!chatid) {
    throw new Error("还没有可推送的会话：需要你先给机器人发一条消息");
  }
  if (!client) throw new Error("机器人客户端未初始化");
  if (!client.isConnected) throw new Error("机器人长连接未连通");

  const body = {
    msgtype: "markdown",
    markdown: { content: String(content).slice(0, 4000) },
  };
  const res = await client.sendMessage(chatid, body);
  log(`[channel] 主动推送成功 chatid=${chatid}`);
  return res;
}
