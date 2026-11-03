/**
 * 通知：个人主体只能"草稿箱 + 人工群发"，所以写完必须让人知道。
 * 支持 none / webhook（企业微信机器人、飞书、自建）/ serverchan
 */

import { env } from "./env.js";

export function notifyEnabled() {
  return env("NOTIFY_CHANNEL", "none") !== "none";
}

/**
 * @param {object} o
 * @param {string} o.title     消息标题
 * @param {string} o.body      markdown 正文
 */
export async function notify({ title, body }) {
  const channel = env("NOTIFY_CHANNEL", "none");
  try {
    if (channel === "serverchan") {
      const key = env("NOTIFY_SERVERCHAN_KEY");
      if (!key) throw new Error("NOTIFY_CHANNEL=serverchan 但没配 NOTIFY_SERVERCHAN_KEY");
      const r = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ title, desp: body }),
      });
      const j = await r.json();
      if (j.code !== 0) throw new Error(`Server酱返回 ${JSON.stringify(j)}`);
      return { ok: true, channel };
    }

    if (channel === "webhook") {
      const url = env("NOTIFY_WEBHOOK_URL");
      if (!url) throw new Error("NOTIFY_CHANNEL=webhook 但没配 NOTIFY_WEBHOOK_URL");
      // 企业微信/飞书机器人通用的 text 消息体：两者都接受 text.content
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: `${title}\n\n${body}` } }),
      });
      if (!r.ok) throw new Error(`webhook HTTP ${r.status}`);
      return { ok: true, channel };
    }

    return { ok: true, channel: "none" };
  } catch (err) {
    // 通知失败不该让已经成功的发文流程变成失败
    return { ok: false, channel, error: err.message };
  }
}
