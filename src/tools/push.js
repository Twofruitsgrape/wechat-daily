#!/usr/bin/env node
/**
 * 把已经生成好的文章推进草稿箱（不重新写稿）。
 *
 *   node src/tools/push.js               推今天（Asia/Shanghai）那一份
 *   node src/tools/push.js 2026-10-30    推指定日期
 *   node src/tools/push.js 2026-10-30 --dry-run
 *
 * 用途：某次运行已经写好了文章，但卡在 AppSecret / 白名单 / 权限上，
 * 修好之后用这个直接推，不必重跑一遍消耗模型额度。
 */

import fs from "node:fs";
import path from "node:path";

import { ROOT, loadEnv, env } from "../env.js";
import { readYaml, dateInTZ, readJson, writeJsonAtomic } from "../util.js";
import { loadState, saveState, upsertRun } from "../state.js";
import * as wx from "../wechat.js";
import { renderWechat } from "../render.js";
import { uploadLocalImages } from "../images.js";

loadEnv();

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const dateArg = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const site = readYaml("config/site.yaml");
const dateStr = dateArg ?? dateInTZ(site.timezone ?? "Asia/Shanghai");

const outDir = path.join(ROOT, "data", "out", dateStr);
const htmlPath = path.join(outDir, "article.html");
const mdPath = path.join(outDir, "article.md");
const coverPath = path.join(outDir, "cover.png");
const metaPath = path.join(outDir, "meta.json");

for (const p of [coverPath, metaPath]) {
  if (!fs.existsSync(p)) {
    console.error(`找不到 ${path.relative(ROOT, p)}`);
    console.error(`先跑 node src/main.js --date=${dateStr} 生成，或者检查日期是否写对。`);
    process.exit(1);
  }
}
if (!fs.existsSync(htmlPath) && !fs.existsSync(mdPath)) {
  console.error(`既没有 article.html 也没有 article.md，没法推。`);
  process.exit(1);
}

const meta = readJson(metaPath, {});
const title = meta?.plan?.title;
const digest = meta?.article?.digest ?? "";

/*
 * 优先从 article.md 重新渲染：因为上一次尝试时如果图片没传上去，
 * article.html 里已经是「删掉图」的版本了，直接用它补推就会丢图。
 * 从 md 重渲染会重新上传图片，能补回配图。
 */
const logger = {
  info: (m) => console.log(`  ${m}`),
  warn: (m) => console.log(`  ⚠️  ${m}`),
  error: (m) => console.log(`  ❌ ${m}`),
};

let html;
if (fs.existsSync(mdPath) && !DRY) {
  console.log("从 article.md 重新渲染（会重新上传正文配图）…");
  const mdin = fs.readFileSync(mdPath, "utf8");
  const mdUploaded = await uploadLocalImages(mdin, logger);
  html = renderWechat(mdUploaded, site.theme ?? {}).html;
} else if (fs.existsSync(htmlPath)) {
  html = fs.readFileSync(htmlPath, "utf8");
} else {
  html = renderWechat(fs.readFileSync(mdPath, "utf8"), site.theme ?? {}).html;
}

if (!title) {
  console.error("meta.json 里没有标题，可能是旧版本的产物。");
  process.exit(1);
}

console.log(`\n准备推送：${dateStr}`);
console.log(`  标题：${title}`);
console.log(`  摘要：${digest}`);
console.log(`  正文：${html.length} 字符`);
console.log(`  封面：${path.relative(ROOT, coverPath)}`);
console.log("");

if (DRY) {
  console.log("（--dry-run，不调用微信接口）");
  process.exit(0);
}

if (!env("WECHAT_APPID") || !env("WECHAT_APPSECRET")) {
  console.error("缺少 WECHAT_APPID / WECHAT_APPSECRET，先配 .env");
  process.exit(1);
}

// 已推过就别重复建草稿
if (meta?.wechat?.draftMediaId) {
  console.log(`这篇已经推过了（draft media_id=${meta.wechat.draftMediaId}）`);
  console.log("确实要再推一份，先删掉 meta.json 里的 wechat.draftMediaId。");
  process.exit(0);
}

try {
  const coverBuf = fs.readFileSync(coverPath);
  const uploaded = await wx.uploadCoverPermanent(coverBuf, `cover-${dateStr}.png`);
  console.log(`封面已上传：${uploaded.mediaId}`);

  const { mediaId } = await wx.addDraft({
    article_type: "news",
    title,
    author: env("WECHAT_AUTHOR") || site.account?.author || "",
    digest,
    content: html,
    content_source_url: env("WECHAT_SOURCE_URL", ""),
    thumb_media_id: uploaded.mediaId,
    need_open_comment: 1,
    only_fans_can_comment: 0,
  });

  console.log(`草稿已进箱：media_id=${mediaId}`);
  console.log("\n→ 打开「订阅号助手」App 或 mp.weixin.qq.com 草稿箱，确认排版后点「群发」");

  fs.writeFileSync(htmlPath, html, "utf8");

  meta.wechat = { ...(meta.wechat ?? {}), mode: env("PUBLISH_MODE", "draft"), coverMediaId: uploaded.mediaId, draftMediaId: mediaId, error: null };
  writeJsonAtomic(metaPath, meta);

  const state = loadState();
  upsertRun(state, dateStr, {
    status: "drafted",
    title,
    topic: meta?.topic?.topic ?? "",
    words: meta?.words,
    coverMediaId: uploaded.mediaId,
    draftMediaId: mediaId,
    draftError: null,
  });
  saveState(state);
} catch (err) {
  console.error(`\n推送失败：${err.message}`);
  process.exit(2);
}
