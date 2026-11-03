/* 【部分未使用】自建应用（CorpID/AgentID）的发消息接口。
   现在走智能机器人长连接（aibot.js + channel.js），此文件仅保留参考。*/
/**
 * 企业微信 API 客户端：拿 token、发应用消息。
 * 只有两个接口，所以不引 SDK。
 */

import { env } from "../env.js";
import { readJson, writeJsonAtomic } from "../util.js";
import path from "node:path";
import { ROOT } from "../env.js";

const BASE = "https://qyapi.weixin.qq.com";
const TOKEN_CACHE = path.join(ROOT, "data", "wecom-token.json");

export function wecomConfig() {
  const cfg = {
    corpId: env("WECOM_CORPID"),
    corpSecret: env("WECOM_CORPSECRET"),
    agentId: env("WECOM_AGENTID"),
    token: env("WECOM_TOKEN"),
    aesKey: env("WECOM_AESKEY"),
    allowedUsers: env("WECOM_ALLOWED_USERS")
      .split(/[,\s]+/)
      .filter(Boolean),
  };
  return cfg;
}

export function isConfigured() {
  const c = wecomConfig();
  return Boolean(c.corpId && c.corpSecret && c.agentId);
}

/** access_token 有效期 7200s，企业微信有日调用上限，必须缓存 */
export async function getAccessToken({ force = false } = {}) {
  const { corpId, corpSecret } = wecomConfig();
  if (!corpId || !corpSecret) throw new Error("缺少 WECOM_CORPID / WECOM_CORPSECRET");

  if (!force) {
    const cached = readJson(TOKEN_CACHE, null);
    if (cached?.token && cached.expiresAt > Date.now() + 60_000) return cached.token;
  }

  const res = await fetch(
    `${BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`,
    { signal: AbortSignal.timeout(15000) }
  );
  const data = await res.json();
  if (data.errcode) {
    throw new Error(`gettoken 失败 errcode=${data.errcode} ${data.errmsg}`);
  }
  const expiresAt = Date.now() + (data.expires_in - 300) * 1000;
  writeJsonAtomic(TOKEN_CACHE, { token: data.access_token, expiresAt });
  return data.access_token;
}

/**
 * 发送文本应用消息给指定成员。
 * @param {string} content
 * @param {object} o
 * @param {string} [o.toUser] 默认发给 WECOM_ALLOWED_USERS 第一个人
 */
export async function sendText(content, { toUser, force = false } = {}) {
  const { agentId, allowedUsers } = wecomConfig();
  const touser = toUser || allowedUsers[0];
  if (!touser) throw new Error("没有收件人：请在 .env 配 WECOM_ALLOWED_USERS（你的企业微信 UserID）");

  const token = await getAccessToken({ force });
  const res = await fetch(`${BASE}/cgi-bin/message/send?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touser,
      msgtype: "text",
      agentid: Number(agentId),
      text: { content: String(content).slice(0, 2000) },
      safe: 0,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();

  // token 过期/无效就强制刷新重试一次
  if ((data.errcode === 42001 || data.errcode === 40014) && !force) {
    return sendText(content, { toUser: touser, force: true });
  }
  if (data.errcode) {
    throw new Error(`message/send 失败 errcode=${data.errcode} ${data.errmsg}`);
  }
  return data;
}
