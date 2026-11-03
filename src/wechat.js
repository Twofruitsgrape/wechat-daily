/**
 * 微信公众号服务端 API 客户端（只用官方接口，不做浏览器自动化）
 *
 * 覆盖流水线需要的全部端点：
 *   stable_token        -> access_token
 *   media/uploadimg     -> 正文内图片换微信 CDN
 *   material/add_material-> 封面图（永久素材，草稿的 thumb_media_id 必须是它）
 *   draft/add           -> 进草稿箱
 *   freepublish/submit  -> 发表（个人主体账号 2025-07 起已被回收权限）
 */

import { env } from "./env.js";
import { loadState, saveState, cacheToken, getCachedToken } from "./state.js";

// 默认直连官方 API；出口 IP 不固定时可用 WECHAT_BASE_URL 指向自己的固定 IP 中转
const BASE = () => (env("WECHAT_BASE_URL") || "https://api.weixin.qq.com").replace(/\/+$/, "");

/* 微信的 errcode 转成人话，出问题时不用再去翻文档 */
const ERROR_HINTS = {
  40001: "AppSecret 不正确，或 access_token 失效（检查 .env 里的 WECHAT_APPSECRET）",
  40002: "grant_type 不对",
  40013: "AppID 非法",
  40007: "media_id 无效（封面素材可能已被删除）",
  40009: "图片大小超过 2MB",
  40004: "媒体文件类型不合法",
  40125: "AppSecret 无效",
  40164: "调用方 IP 不在公众平台 IP 白名单里 —— 登录公众平台「设置与开发 → 基本配置 → IP 白名单」添加本机出口 IP",
  41001: "缺少 access_token",
  42001: "access_token 已过期（会自动刷新重试一次）",
  45002: "内容超长（正文上限约 2 万字符，或群发频次超限）",
  45009: "接口调用超过当日上限",
  45028: "没有群发权限",
  48001: "该接口未授权 —— 个人主体账号 2025 年 7 月起被回收「发布」接口权限，只能进草稿箱后在手机端群发",
  53404: "账号未认证，该接口仅对认证账号开放",
};

export class WeChatError extends Error {
  constructor(code, msg, endpoint) {
    const hint = ERROR_HINTS[code];
    // 40164 的 errmsg 形如：invalid ip 203.0.113.42 ipv6 ::ffff:..., not in whitelist
    // 这是唯一能“问”出微信到底看到的你哪个 IP 的途径
    const ipMatch = code === 40164 ? String(msg).match(/invalid ip\s+([\d.]+)/i) : null;
    super(
      `[${endpoint}] errcode=${code} ${msg}${hint ? `\n  → ${hint}` : ""}${
        ipMatch ? `\n  → 微信看到的你的 IP 是：${ipMatch[1]}` : ""
      }`
    );
    this.code = code;
    this.endpoint = endpoint;
    this.raw = msg;
    this.ip = ipMatch ? ipMatch[1] : null;
  }
}

function appid() {
  const v = env("WECHAT_APPID");
  if (!v) throw new Error("缺少 WECHAT_APPID");
  return v;
}
function secret() {
  const v = env("WECHAT_APPSECRET");
  if (!v) throw new Error("缺少 WECHAT_APPSECRET（公众平台 → 设置与开发 → 基本配置 → 开发者密码）");
  return v;
}

async function postJson(url, body, endpoint) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`[${endpoint}] 返回非 JSON：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (data.errcode) throw new WeChatError(data.errcode, data.errmsg, endpoint);
  return data.data ?? data; // 部分接口把结果包在 data 里
}

async function postForm(url, blob, filename, endpoint) {
  const form = new FormData();
  form.append("media", blob, filename);
  const res = await fetch(url, { method: "POST", body: form });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`[${endpoint}] 返回非 JSON：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (data.errcode) throw new WeChatError(data.errcode, data.errmsg, endpoint);
  return data;
}

/* ------------------------------ access_token ------------------------------ */

let memToken = null;

export async function getAccessToken({ force = false, refreshMarginMs = 10 * 60_000 } = {}) {
  // 提前 10 分钟就换，避免“刚好在过期那一刻刷新”被频控拦住
  if (!force && memToken && Date.now() < memToken.expiresAt - refreshMarginMs) return memToken.accessToken;

  if (!force) {
    const state = loadState();
    const cached = getCachedToken(state);
    if (cached && Date.now() < state.token.expiresAt - refreshMarginMs) {
      memToken = { accessToken: cached, expiresAt: state.token.expiresAt };
      return cached;
    }
    // 快过期了也先用着，总比拿不到 token 好
    if (cached) {
      memToken = { accessToken: cached, expiresAt: state.token.expiresAt };
      try {
        return await fetchToken(false);
      } catch {
        return cached;
      }
    }
  }

  return fetchToken(Boolean(force));
}

/** 真正去换 token。45009 是频控，退避重试几次（别硬刷，会越刷越久） */
async function fetchToken(force) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await postJson(
        `${BASE()}/cgi-bin/stable_token`,
        {
          grant_type: "client_credential",
          appid: appid(),
          secret: secret(),
          force_refresh: force,
        },
        "stable_token"
      );
      if (!data.access_token) {
        throw new Error(`stable_token 没有返回 access_token：${JSON.stringify(data)}`);
      }
      const expiresIn = data.expires_in ?? 7200;
      memToken = { accessToken: data.access_token, expiresAt: Date.now() + (expiresIn - 300) * 1000 };
      const state = loadState();
      cacheToken(state, data.access_token, expiresIn);
      return data.access_token;
    } catch (err) {
      lastErr = err;
      if (err?.code !== 45009 || attempt === 3) throw err;
      const wait = 5000 * attempt * attempt; // 5s, 20s
      console.error(`[stable_token] 触发频控（45009），${wait / 1000}s 后第 ${attempt + 1} 次尝试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/** 包一层：token 过期类错误自动刷新重试一次 */
async function withToken(fn) {
  let token = await getAccessToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof WeChatError && (err.code === 42001 || err.code === 40014 || err.code === 40001)) {
      token = await getAccessToken({ force: true });
      return await fn(token);
    }
    throw err;
  }
}

/* -------------------------------- 素材 -------------------------------- */

/** 正文内图片：返回可直接写进 <img src> 的微信 CDN 地址 */
export async function uploadContentImage(buffer, filename = "img.png") {
  return withToken(async (token) => {
    const type = filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
    const data = await postForm(
      `${BASE()}/cgi-bin/media/uploadimg?access_token=${token}`,
      new Blob([buffer], { type }),
      filename,
      "media/uploadimg"
    );
    if (!data.url) throw new Error(`uploadimg 没有返回 url：${JSON.stringify(data)}`);
    return data.url;
  });
}

/** 封面图：永久素材，返回 { media_id, url } */
export async function uploadCoverPermanent(buffer, filename = "cover.png") {
  return withToken(async (token) => {
    const type = filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
    const data = await postForm(
      `${BASE()}/cgi-bin/material/add_material?access_token=${token}&type=image`,
      new Blob([buffer], { type }),
      filename,
      "material/add_material"
    );
    if (!data.media_id) throw new Error(`add_material 没有返回 media_id：${JSON.stringify(data)}`);
    return { mediaId: data.media_id, url: data.url };
  });
}

/* -------------------------------- 草稿 -------------------------------- */

/**
 * 新增草稿。注意：个人主体账号只能走到这一步。
 * @returns {Promise<{mediaId:string}>}
 */
export async function addDraft(article) {
  return withToken(async (token) => {
    const data = await postJson(
      `${BASE()}/cgi-bin/draft/add?access_token=${token}`,
      { articles: [article] },
      "draft/add"
    );
    if (!data.media_id) throw new Error(`draft/add 没有返回 media_id：${JSON.stringify(data)}`);
    return { mediaId: data.media_id };
  });
}

export async function listDrafts({ offset = 0, count = 20, noContent = 1 } = {}) {
  return withToken(async (token) =>
    postJson(
      `${BASE()}/cgi-bin/draft/batchget?access_token=${token}`,
      { offset, count, no_content: noContent },
      "draft/batchget"
    )
  );
}

/* -------------------------------- 发表 -------------------------------- */

/** 提交发表（个人号会 48001 / 53404） */
export async function submitFreePublish(mediaId) {
  return withToken(async (token) => {
    const data = await postJson(
      `${BASE()}/cgi-bin/freepublish/submit?access_token=${token}`,
      { media_id: mediaId },
      "freepublish/submit"
    );
    return { publishId: data.publish_id ?? data.publishid ?? null, raw: data };
  });
}

export async function getPublishStatus(publishId) {
  return withToken(async (token) =>
    postJson(
      `${BASE()}/cgi-bin/freepublish/get?access_token=${token}`,
      { publish_id: publishId },
      "freepublish/get"
    )
  );
}

/** 发布状态轮询：0 成功 / 1 发表中 / 2 原创失败 / 3 常规失败 / 4 平台审核不通过 / 5 成功但被用户删除 */
export async function waitForPublish(publishId, { timeoutMs = 120_000, intervalMs = 5000 } = {}) {
  const start = Date.now();
  const STATUS = {
    0: "发布成功",
    1: "发表中",
    2: "原创失败（不视为发布失败）",
    3: "常规失败",
    4: "平台审核不通过",
    5: "发布成功后又被删除",
  };
  while (Date.now() - start < timeoutMs) {
    const r = await getPublishStatus(publishId);
    const st = Number(r.publish_status);
    if (st === 0 || st === 2) return { ok: true, status: st, label: STATUS[st], raw: r };
    if (st === 3 || st === 4 || st === 5) return { ok: false, status: st, label: STATUS[st], raw: r };
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { ok: false, status: 1, label: "超时仍在发表中，请稍后在后台确认", raw: null };
}

/* ------------------------------ 自检辅助 ------------------------------ */

/** 只验证 AppID/AppSecret/白名单是否可用，不做任何写操作 */
export async function probeCredentials() {
  try {
    const t = await getAccessToken({ force: true });
    return { ok: true, tokenTail: t.slice(-8) };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

/** 取本机出口 IP（写进白名单要用） */
export async function detectEgressIp() {
  const endpoints = ["https://ipinfo.io/ip", "https://ip.sb", "https://ifconfig.co/ip"];
  const ips = new Set();
  for (const u of endpoints) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      const t = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) ips.add(t);
    } catch {
      /* 忽略单个探测点失败 */
    }
  }
  return [...ips];
}
