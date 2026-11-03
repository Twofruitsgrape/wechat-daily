#!/usr/bin/env node
/**
 * 接口权限探测：用真实 AppID/AppSecret 逐个打一遍微信接口，
 * 确认个人主体账号到底能用哪一步。
 *
 *   node src/tools/probe.js            只读（token + 草稿列表）
 *   node src/tools/probe.js --write    会真的往素材库/草稿箱写测试数据
 *
 * 为什么需要这个：微信官方对"个人订阅号能否调草稿箱接口"的口径前后矛盾，
 * 2022 年社区回复说"无需认证即可调用"，2023 年后又有大量 48001 投诉。
 * 只有拿你自己的号打一遍才知道。
 */

import { loadEnv, env } from "../env.js";
import * as wx from "../wechat.js";
import sharp from "sharp";

loadEnv();
const WRITE = process.argv.includes("--write");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const icon = ok === true ? "✅" : ok === "skip" ? "⏭ " : ok === "partial" ? "⚠️ " : "❌";
  console.log(`${icon} ${name}${detail ? `  —  ${detail}` : ""}`);
}

console.log("\n=== 微信公众号接口权限探测 ===");
console.log(`AppID: ${env("WECHAT_APPID") || "(未配置)"}`);
console.log(`模式: ${WRITE ? "含写操作" : "只读"}\n`);

if (!env("WECHAT_APPID") || !env("WECHAT_APPSECRET")) {
  console.error("缺少 WECHAT_APPID 或 WECHAT_APPSECRET，先配好 .env 再跑。");
  process.exit(1);
}

/* 1. access_token —— 同时验证 AppSecret 和 IP 白名单 */
let token = null;
try {
  token = await wx.getAccessToken({ force: true });
  record("stable_token（AppSecret + IP 白名单）", true, `token 尾号 ${token.slice(-8)}`);
} catch (err) {
  record("stable_token（AppSecret + IP 白名单）", false, err.message.split("\n")[0]);
  printSummary();
  process.exit(1);
}

/* 2. 读草稿列表 —— 只读，能反映草稿箱能力是否开通 */
try {
  const r = await wx.listDrafts({ count: 1 });
  const total = r.total_count ?? 0;
  record("draft/batchget（读草稿箱）", true, `现有草稿 ${total} 篇`);
} catch (err) {
  record("draft/batchget（读草稿箱）", false, err.message.split("\n")[0]);
}

if (!WRITE) {
  console.log("\n（只读模式到此为止。要测素材上传和建草稿，加 --write）");
  printSummary();
  process.exit(0);
}

/* 3. 造一张测试图 */
const png = await sharp({
  create: { width: 300, height: 128, channels: 3, background: { r: 60, g: 90, b: 200 } },
}).png().toBuffer();

/* 4. 永久素材（封面用） */
let coverMediaId = null;
try {
  const r = await wx.uploadCoverPermanent(png, "probe-cover.png");
  coverMediaId = r.mediaId;
  record("material/add_material（永久素材，封面）", true, `media_id=${coverMediaId}`);
} catch (err) {
  record("material/add_material（永久素材，封面）", false, err.message.split("\n")[0]);
}

/* 5. 图文内图片 */
try {
  const url = await wx.uploadContentImage(png, "probe-inline.png");
  record("media/uploadimg（正文配图）", true, url.slice(0, 60) + "…");
} catch (err) {
  record("media/uploadimg（正文配图）", false, err.message.split("\n")[0]);
}

/* 6. 建草稿 —— 决定性的那一步 */
if (!coverMediaId) {
  record("draft/add（建草稿）", "skip", "ctx：封面素材上传失败，跳过");
} else {
  try {
    const r = await wx.addDraft({
      article_type: "news",
      title: `接口探测草稿 ${new Date().toISOString().slice(0, 16)}`,
      author: "",
      digest: "这是 wechat-daily 的接口权限探测草稿，可直接删除。",
      content: `<section style="font-size:16px;color:#3f3f3f;line-height:1.8;"><p>如果你在草稿箱里看到这段文字，说明这台机器的流水线可以自动建草稿。</p></section>`,
      content_source_url: "",
      thumb_media_id: coverMediaId,
      need_open_comment: 0,
      only_fans_can_comment: 0,
    });
    record("draft/add（建草稿）", true, `media_id=${r.mediaId} ← 去后台草稿箱看看有没有`);
  } catch (err) {
    record("draft/add（建草稿）", false, err.message.split("\n")[0]);
  }
}

printSummary();

function printSummary() {
  console.log("\n" + "─".repeat(56));
  const failed = results.filter((r) => r.ok === false);
  const token = results.find((r) => r.name.startsWith("stable_token"));
  const draftList = results.find((r) => r.name.startsWith("draft/batchget"));
  const draftAdd = results.find((r) => r.name.startsWith("draft/add"));
  const material = results.find((r) => r.name.startsWith("material/add_material"));

  if (!token?.ok) {
    console.log("结论：连 access_token 都拿不到，先把 AppSecret 和 IP 白名单搞定。");
  } else if (material?.ok === false) {
    console.log("结论：永久素材接口不可用 → 封面无法上传 → 只能走浏览器自动化路线。");
  } else if (draftAdd?.ok === false) {
    console.log("结论：草稿箱接口对你的号未开通（48001）。");
    console.log("      流水线仍然可以跑，但产出停在 data/out/<date>/article.html，");
    console.log("      需要改成「本地生成 + 浏览器自动化粘贴」或手动复制。");
  } else if (draftAdd?.ok === true) {
    console.log("结论：全链路可用 ✅  自动写作 → 排版 → 封面 → 进草稿箱，只剩你点一下群发。");
  } else if (draftList?.ok === true) {
    console.log("结论：草稿箱可读。加 --write 测建草稿才能确认能否写入。");
  } else {
    console.log("结论：见上面各项。");
  }
  console.log("─".repeat(56));
  if (failed.length) {
    console.log("\n提示：48001 = 该号没有此接口权限；40164 = IP 不在白名单；");
    console.log("      40001/40125 = AppSecret 错；40009 = 图片超 2MB。");
  }
}
