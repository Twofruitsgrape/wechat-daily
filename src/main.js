#!/usr/bin/env node
/**
 * 每日发文主流程
 *
 * 用法：
 *   node src/main.js                 正常跑（按 .env 的 PUBLISH_MODE）
 *   node src/main.js --dry-run       只生成文章/封面/HTML，不碰微信接口
 *   node src/main.js --force         今天已经跑过也重跑
 *   node src/main.js --date=2026-10-30 --force
 *   node src/main.js --no-review     跳过自检
 */

import fs from "node:fs";
import path from "node:path";

import { ROOT, loadEnv, env, requireEnv } from "./env.js";
import { readYaml, dateInTZ, createLogger, ensureDir, writeJsonAtomic, countHan, nowIso } from "./util.js";
import { loadState, saveState, getRun, upsertRun, rememberTopic, recentTitles } from "./state.js";
import { chooseTopic } from "./topic.js";
import { planArticle, writeArticle, reviewArticle, expandArticle } from "./writer.js";
import { renderCover } from "./cover.js";
import { renderWechat } from "./render.js";
import { attachPaperFigures, attachFiguresFromFile, readPdfText, topicFromPaper } from "./paper.js";
import { uploadLocalImages } from "./images.js";
import * as wx from "./wechat.js";
import { usage } from "./llm.js";
import { notify, notifyEnabled } from "./notify.js";

/* ------------------------------ 参数解析 ------------------------------ */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY = has("--dry-run");
const FORCE = has("--force");
const NO_REVIEW = has("--no-review");
const UNTIL = val("until") ?? null; // render | draft | publish
// 外部传入的选题（比如机器人/网页面板拿到用户回复后传进来）
const TOPIC = val("topic");
// 用户本次额外的写作要求，会拼进大纲和正文的 prompt
const BRIEF = val("brief");
// 文献配图：--paper=auto（根据选题自动搜）或 --paper="检索词"
const PAPER = val("paper");
// 用户直接发来 PDF：--from-paper=<pdf 路径>，以这篇论文为唯一依据写解读稿
const FROM_PAPER = val("from-paper");

/* ------------------------------ 启动 ------------------------------ */
loadEnv();

const site = readYaml("config/site.yaml");
const dateStr = val("date") ?? dateInTZ(site.timezone ?? "Asia/Shanghai");
const log = createLogger(dateStr);

const TOTAL = 10;
let stepNo = 0;
const step = (msg) => log.step(++stepNo, TOTAL, msg);

async function main() {
  log.info(`=========== 开始：${dateStr} ${DRY ? "[DRY-RUN]" : ""} ===========`);

  const state = loadState();
  const prev = getRun(state, dateStr);
  if (prev && ["drafted", "published"].includes(prev.status) && !FORCE && !DRY) {
    log.info(`今天已经处理过了（status=${prev.status}，草稿 media_id=${prev.draftMediaId ?? "-"}），跳过。用 --force 强制重跑。`);
    return { skipped: true, run: prev };
  }

  const outDir = ensureDir(path.join(ROOT, "data", "out", dateStr));

  /* 0. 如果给了 PDF，先把原文读出来（后面写作和配图都要用） */
  let paperText = "";
  let pdfPath = null;
  if (FROM_PAPER) {
    pdfPath = path.isAbsolute(FROM_PAPER) ? FROM_PAPER : path.join(ROOT, FROM_PAPER);
    if (!fs.existsSync(pdfPath)) throw new Error(`找不到 PDF：${pdfPath}`);
    paperText = await readPdfText(pdfPath, { log });
    log.info(`已读取论文原文 ${paperText.length} 字符`);
  }

  /* 1. 选题 */
  step("选题");
  const picked =
    TOPIC && TOPIC.trim()
      ? {
          topic: TOPIC.trim(),
          angle: "",
          source: "cli",
          remaining: 0,
        }
      : paperText
        ? await topicFromPaper(paperText, { log })
        : await chooseTopic({ site, state, dateStr, log });
  if (picked.source === "cli") log.info(`选题来自外部传入：${picked.topic}`);

  /* 2. 大纲 */
  step("大纲");
  const plan = await planArticle({ site, picked, brief: BRIEF, source: paperText, history: recentTitles(state, 20), log });

  /* 3. 正文 */
  step("写正文");
  let { markdown, words } = await writeArticle({ site, picked, plan, brief: BRIEF, source: paperText, log });

  /* 4. 篇幅不够就补写 */
  step("补足篇幅");
  {
    const r = await expandArticle({ site, plan, markdown, log });
    markdown = r.markdown;
    words = r.words;
  }

  /* 5. 自检 */
  if (site.article?.enable_review !== false && !NO_REVIEW) {
    step("自检润色");
    const r = await reviewArticle({ site, plan, markdown, log });
    markdown = r.markdown;
    words = r.words;
  } else {
    step("自检润色（已跳过）");
  }

  markdown = normalizeMarkdown(markdown, site);
  const finalWords = countHan(markdown);
  let paperInfo = null;
  let figureCount = 0;

  /* 6. 文献配图 */
  if (pdfPath) {
    step("从 PDF 抽图配图");
    const r = await attachFiguresFromFile({
      pdfPath,
      markdown,
      outDir,
      paperMeta: { paperTitle: picked.paperTitle, title: plan.title },
      log,
      max: 4,
    });
    markdown = r.markdown;
    figureCount = r.figures;
    paperInfo = r.paper ?? { paperTitle: picked.paperTitle, fromUserPdf: true };
  } else if (PAPER) {
    step("找文献配图");
    const r = await attachPaperFigures({
      topic: PAPER && PAPER !== "auto" ? `${picked.topic} ${PAPER}` : picked.topic,
      markdown,
      outDir,
      log,
      max: 4,
    });
    markdown = r.markdown;
    paperInfo = r.paper;
    figureCount = r.figures;
  } else {
    step("找文献配图（未启用）");
  }

  /* 7. 封面 */
  step("生成封面");
  const coverPath = path.join(outDir, "cover.png");
  const cover = await renderCover({
    title: plan.cover_title || plan.title,
    date: dateStr,
    kicker: site.cover?.kicker ?? "",
    brand: site.account?.name ?? "",
    theme: site.cover?.theme ?? "auto",
    size: { width: site.cover?.width ?? 900, height: site.cover?.height ?? 383 },
    out: coverPath,
  });
  log.info(`封面：${cover.width}x${cover.height} 主题 ${cover.theme}，${cover.lines.length} 行`);

  /* 7. 排版 + 上传正文图 */
  step("排版");
  let mdForRender = markdown;
  if (!DRY && UNTIL !== "render") {
    mdForRender = await uploadLocalImages(markdown, log);
  }
  const { html, footnotes } = renderWechat(mdForRender, site.theme ?? {}, {});
  const htmlPath = path.join(outDir, "article.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  log.info(`HTML：${html.length} 字符，${footnotes.length} 个外部链接收进文末`);

  const mdPath = path.join(outDir, "article.md");
  fs.writeFileSync(mdPath, markdown, "utf8");

  /* 8. 进草稿箱 */
  const mode = env("PUBLISH_MODE", "draft");
  const digest =
    clipSoft(plan.digest ?? "", 44) || clipSoft(stripMd(markdown).slice(0, 60), 44);
  const article = {
    article_type: "news",
    title: clip(plan.title, 60),
    author: env("WECHAT_AUTHOR") || site.account?.author || "",
    digest,
    content: html,
    content_source_url: env("WECHAT_SOURCE_URL", ""),
    thumb_media_id: "",
    need_open_comment: 1,
    only_fans_can_comment: 0,
  };

  let draftMediaId = null;
  let coverMediaId = null;
  let publishId = null;
  let publishStatus = null;
  let draftError = null;

  const doDraft = !DRY && UNTIL !== "render";
  const doPublish = doDraft && mode === "freepublish" && UNTIL !== "draft";

  step(doDraft ? "上传封面 + 建草稿" : "上传封面 + 建草稿（已跳过）");
  if (doDraft) {
    // 这一段依赖微信凭证，失败时不能把已经生成好的文章丢掉，
    // 所以只记录错误，后面照常落盘 meta 和 state。
    try {
      requireEnv(["WECHAT_APPID", "WECHAT_APPSECRET"]);
      const buf = fs.readFileSync(coverPath);
      const uploaded = await retryOnIpDrift(() => wx.uploadCoverPermanent(buf, `cover-${dateStr}.png`));
      coverMediaId = uploaded.mediaId;
      log.info(`封面已上传为永久素材：${coverMediaId}`);

      article.thumb_media_id = coverMediaId;
      const d = await retryOnIpDrift(() => wx.addDraft(article));
      draftMediaId = d.mediaId;
      log.info(`草稿已进箱：media_id=${draftMediaId}`);
    } catch (err) {
      draftError = err.message;
      log.error(`进草稿箱失败：${err.message}`);
    }

    /* 9. 发表（仅认证主体可用） */
    if (!draftError && doPublish) {
      step("提交发表");
      try {
        const r = await wx.submitFreePublish(draftMediaId);
        publishId = r.publishId;
        log.info(`已提交发表：publish_id=${publishId}`);
        const st = await wx.waitForPublish(publishId, { timeoutMs: 180_000 });
        publishStatus = st.label;
        if (st.ok) log.info(`发表结果：${st.label}`);
        else log.error(`发表失败：${st.label}`);
      } catch (err) {
        publishStatus = `失败：${err.message}`;
        log.error(`提交发表失败：${err.message}`);
      }
    } else {
      step(`提交发表（${draftError ? "建草稿失败，跳过" : `PUBLISH_MODE=${mode}`}）`);
    }
  } else {
    step("提交发表（已跳过）");
  }

  /* 落盘 meta */
  const meta = {
    date: dateStr,
    generatedAt: nowIso(),
    dryRun: DRY,
    topic: picked,
    plan,
    article: { ...article, content: `[${html.length} chars, 见 article.html]` },
    words: finalWords,
    figures: figureCount,
    paper: paperInfo
      ? {
          title: paperInfo.title,
          authors: paperInfo.authors?.slice(0, 6),
          arxivId: paperInfo.arxivId,
          published: paperInfo.published,
          license: paperInfo.license,
          absUrl: paperInfo.absUrl,
        }
      : null,
    cover: { ...cover, path: path.relative(ROOT, coverPath) },
    files: {
      markdown: path.relative(ROOT, mdPath),
      html: path.relative(ROOT, htmlPath),
      cover: path.relative(ROOT, coverPath),
    },
    wechat: { mode, coverMediaId, draftMediaId, publishId, publishStatus, error: draftError },
    llm: { ...usage },
  };
  writeJsonAtomic(path.join(outDir, "meta.json"), meta);

  /* 状态记录 */
  const status = draftError
    ? "failed"
    : publishStatus && !String(publishStatus).startsWith("失败")
      ? "published"
      : draftMediaId
        ? "drafted"
        : "generated";
  upsertRun(state, dateStr, {
    status,
    title: plan.title,
    topic: picked.topic,
    coverTitle: plan.cover_title,
    words: finalWords,
    topicSource: picked.source,
    coverMediaId,
    draftMediaId,
    publishId,
    publishStatus,
    draftError,
    llmCost: usage.cost,
  });
  if (!prev) rememberTopic(state, picked.topic, plan.title);
  saveState(state);

  /* 通知 */
  if ((doDraft || draftError) && notifyEnabled()) {
    const lines = [
      `《${plan.title}》`,
      `字数：${finalWords}`,
      draftMediaId ? `草稿 media_id：${draftMediaId}` : "",
      status === "drafted" ? "→ 打开「订阅号助手」App 或 mp.weixin.qq.com 草稿箱，确认后点「群发」" : "",
      draftError ? `❌ 进草稿箱失败：${draftError}` : "",
      publishStatus ? `发表状态：${publishStatus}` : "",
    ].filter(Boolean);
    const n = await notify({
      title: draftError ? `今日流水线失败 · ${dateStr}` : `今日草稿已就绪 · ${dateStr}`,
      body: lines.join("\n"),
    });
    if (!n.ok) log.warn(`通知发送失败：${n.error}`);
    else log.info(`通知已发送（${n.channel}）`);
  }

  log.info(`=========== 完成：${status} ===========`);
  return { status, meta, outDir, draftError };
}

/* ------------------------------ 工具函数 ------------------------------ */

/**
 * 出口 IP 漂移的自动重试。
 *
 * 很多网络环境（校园网 / 公司 NAT / 多线路）的出口 IP 会在几个地址之间漂移：
 * 平时命中白名单里那个，偶尔跳到另一个没加白名单的 IP，微信就返回 40164。但那个跳转是瞬时的，等几十秒往往就切回来了。
 * 所以遇到 40164 不直接判死，而是等一等重试。
 */
async function retryOnIpDrift(fn, { attempts = 4, waitMs = 45_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const isIp = err?.code === 40164;
      if (!isIp || i >= attempts) throw err;
      log.warn(
        `出口 IP 不在白名单（${err.ip ?? "?"}），第 ${i}/${attempts} 次；等 ${waitMs / 1000}s 重试…`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

/** 在标点处断开，不要在句子中间剪一刀 */
function clipSoft(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  const cut = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf("！"),
    head.lastIndexOf("？"),
    head.lastIndexOf("；"),
    head.lastIndexOf("，")
  );
  return cut > n * 0.55 ? head.slice(0, cut) : clip(t, n);
}

function stripMd(s) {
  return String(s)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>~-]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 删掉正文里可能出现的重复一级标题、收尾废话，追加互动尾注 */
function normalizeMarkdown(md, site) {
  let s = md.trim();

  // 模型偶尔会把标题又写进正文
  s = s.replace(/^#\s+.+\n+/, "");

  // 去掉模型自作主张加的"参考资料/延伸阅读"模块
  s = s.replace(/\n#{2,3}\s*(参考资料|参考文献|延伸阅读|Referenc\w*)\s*\n[\s\S]*$/i, "\n");

  // 去掉开头"以下是..."之类的元叙述
  s = s.replace(/^(好的|当然|以下是|这是一篇)[^\n]{0,40}\n+/, "");

  // 合并"碎片段"。模型很容易把一句话单独成段，手机上会变成一堆零散的白底块，
  // 这是排版最伤的一个毛病。把短段和相邻段合并，但不超过 220 字（约 5-6 行）。
  s = mergeShortParagraphs(s);

  if (site.theme?.show_footer && site.theme?.footer_text) {
    s += `\n\n---\n\n> ${site.theme.footer_text.trim()}\n`;
  }
  return s.trim();
}

/** 是否是普通正文段落（不是标题/列表/引用/图片/表格/代码） */
function isPlainPara(block) {
  const t = block.trim();
  if (!t) return false;
  return !/^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|!\[|\||<)/.test(t);
}

function mergeShortParagraphs(md) {
  const blocks = md.split(/\n{2,}/);
  const out = [];
  const SHORT = 70; // 少于这么多字算碎片段
  const MAX = 220; // 合并后不超过这个长度

  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (
      prev &&
      isPlainPara(prev) &&
      isPlainPara(block) &&
      (prev.trim().length < SHORT || block.trim().length < SHORT) &&
      prev.trim().length + block.trim().length <= MAX
    ) {
      // 中文段落直接拼，不加空格
      out[out.length - 1] = prev.trimEnd() + block.trim();
    } else {
      out.push(block);
    }
  }
  return out.join("\n\n");
}

/** 把正文里引用的本地图片上传到微信 CDN，并替换 src（实现已搬到 src/images.js）*/

/* ------------------------------ 入口 ------------------------------ */
main()
  .then((r) => {
    if (r?.skipped) process.exit(0);
    const m = r.meta;
    console.log("\n" + "─".repeat(60));
    console.log(`标题：${m.plan.title}`);
    console.log(`封面标题：${m.plan.cover_title}`);
    console.log(`摘要：${m.article.digest}`);
    console.log(`字数：${m.words}   主题来源：${m.topic.source}`);
    console.log(`产物：${r.outDir}`);
    if (m.wechat.draftMediaId) console.log(`草稿 media_id：${m.wechat.draftMediaId}`);
    if (m.wechat.publishStatus) console.log(`发表：${m.wechat.publishStatus}`);
    if (m.dryRun) console.log("（dry-run：未调用微信接口）");
    if (r.draftError) {
      console.log(`\n⚠️  进草稿箱失败：${r.draftError}`);
      console.log(`   文章已保存：${r.outDir}`);
    }
    console.log("─".repeat(60));
    process.exit(r.draftError ? 2 : 0);
  })
  .catch((err) => {
    log.error(err.stack || err.message);
    console.error("\n运行失败：" + err.message);
    process.exit(1);
  });
