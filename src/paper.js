/**
 * 从学术论文里取插图，配进正文。
 *
 * 链路：中文选题 → 翻成英文检索词 → arXiv 搜文献 → 下 PDF → pdfimages 抽图
 *       → 视觉模型逐张判断「是不是真图表」并写图注 → 按小节插入正文。
 *
 * 几个踩过的坑记在这里：
 *   1. arXiv 只走 https。http://export.arxiv.org 在这台机器上直接超时。
 *   2. deepseek-v4-pro 没有视觉能力（会回「我无法读取图片」）。
 *      有视觉的是 deepseek-v4.1-flash / claude-haiku-5-5 / kimi-k3。
 *   3. 视觉模型也是推理模型，max_tokens 给小了会全被 reasoning 吃掉、
 *      content 返回空字符串。这里固定给 2500。
 *   4. pdfimages 抽出来的一大半是图标、公式碎片、排版装饰，必须先让模型筛一遍。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

import { env } from "./env.js";
import { chat } from "./llm.js";
import { ensureDir, escapeHtml } from "./util.js";

const run = promisify(execFile);
const VISION_MODEL = () => env("PAPER_VISION_MODEL", "deepseek-v4.1-flash");

/* ---------------------------- arXiv 检索 ---------------------------- */

function xmlFieldAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]);
}
function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** 把中文选题翻成适合 arXiv 检索的英文关键词 */
export async function toSearchQuery(topic, log) {
  const { content } = await chat({
    model: env("OPENCODE_MODEL_FAST") || env("OPENCODE_MODEL"),
    temperature: 0.2,
    maxTokens: 2500,
    tag: "paper.query",
    messages: [
      {
        role: "user",
        content: `把下面这个中文选题转成用来检索英文学术论文的查询词。

选题：${topic}

要求：
- 只输出检索词本身，不要引号、不要解释、不要 "query:" 前缀
- 用英文，3-6 个词，用空格分隔
- 优先用该领域的标准术语（例如 MVR 用 "mechanical vapor recompression"）
- 不要带年份、不要带 and/or 之类布尔词`,
      },
    ],
  });
  const q = content.trim().replace(/^["'`]+|["'`]+$/g, "").split("\n")[0];
  log?.info(`英文检索词：${q}`);
  return q;
}

export async function searchArxiv(query, { max = 6, log } = {}) {
  // 关键：先用**短语**检索。直接 all:a b c 是宽松匹配，会抳回完全不相关的论文
  // （实测 all:mechanical vapor recompression specific energy consumption 返回了深度学习与暗能量宇宙学的文章）。
  const attempts = [`all:"${query}"`, `abs:"${query}"`, query.split(/\s+/).slice(0, 3).map((w) => `all:${w}`).join(" AND ")];

  for (const q of attempts) {
    const url =
      "https://export.arxiv.org/api/query?search_query=" +
      encodeURIComponent(q) +
      `&max_results=${max}&sortBy=relevance`;

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`arXiv 检索失败 HTTP ${res.status}`);
    const xml = await res.text();

    const entries = xmlFieldAll(xml, "entry")
      .map((e) => {
        const id = stripTags(xmlFieldAll(e, "id")[0] ?? "");
        const arxivId = id.match(/abs\/([^v]+)(v\d+)?$/)?.[1] ?? "";
        return {
          source: "arXiv",
          title: stripTags(xmlFieldAll(e, "title")[0] ?? ""),
          summary: stripTags(xmlFieldAll(e, "summary")[0] ?? ""),
          authors: xmlFieldAll(e, "name").map(stripTags).filter(Boolean),
          published: stripTags(xmlFieldAll(e, "published")[0] ?? "").slice(0, 10),
          arxivId,
          absUrl: id,
          pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : "",
          license: stripTags(xmlFieldAll(e, "arxiv:license")[0] ?? ""),
          journal: stripTags(xmlFieldAll(e, "arxiv:journal_ref")[0] ?? ""),
        };
      })
      .filter((e) => e.arxivId && e.pdfUrl && isRelevant(e, query));

    if (entries.length) {
      log?.info(`arXiv（${q.slice(0, 40)}…）命中 ${entries.length} 篇`);
      entries.slice(0, 3).forEach((e) => log?.info(`  · ${e.title.slice(0, 70)} (${e.published})`));
      return entries;
    }
  }
  log?.info("arXiv 没有命中相关文献");
  return [];
}

/** 粗略的相关性过滤：标题或摘要里得出现查询里的主要词 */
function isRelevant(entry, query) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(with|from|that|this|into|under|over|using)$/.test(w));
  if (!terms.length) return true;
  const hay = (entry.title + " " + entry.summary).toLowerCase();
  const hit = terms.filter((t) => hay.includes(t)).length;
  return hit >= Math.max(1, Math.ceil(terms.length * 0.5));
}

/** OpenAlex：开放获取库，工程类文献比 arXiv 全得多 */
export async function searchOpenAlex(query, { max = 6, log } = {}) {
  const url =
    "https://api.openalex.org/works?search=" +
    encodeURIComponent(query) +
    `&filter=is_oa:true&per-page=${max}&sort=relevance_score:desc`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const entries = (j.results ?? [])
      .map((w) => {
        const pdf = w.best_oa_location?.pdf_url || w.primary_location?.pdf_url || "";
        return {
          source: "OpenAlex",
          title: w.title ?? "",
          summary: "",
          authors: (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
          published: String(w.publication_year ?? ""),
          arxivId: "",
          doi: (w.doi ?? "").replace(/^https?:\/\/doi.org\//, ""),
          absUrl: w.doi ?? w.id ?? "",
          pdfUrl: pdf,
          license: w.best_oa_location?.license ?? "",
          journal: w.primary_location?.source?.display_name ?? "",
        };
      })
      .filter((e) => e.pdfUrl && isRelevant({ ...e, summary: e.title }, query));
    log?.info(`OpenAlex 命中 ${entries.length} 篇带 PDF 的开放获取文献`);
    entries.slice(0, 3).forEach((e) => log?.info(`  · ${e.title.slice(0, 70)} (${e.published})`));
    return entries;
  } catch (err) {
    log?.warn(`OpenAlex 检索失败：${err.message}`);
    return [];
  }
}

/** 两个源合起来找，优先 arXiv（排版规范、图好抽） */
export async function findPapers(query, { log } = {}) {
  const arxiv = await searchArxiv(query, { log }).catch(() => []);
  if (arxiv.length) return arxiv;
  return searchOpenAlex(query, { log });
}

/* ---------------------------- 抽图 ---------------------------- */

/** 下载一个远程 PDF 到 outDir，返回本地路径 */
export async function downloadPdf(pdfUrl, outDir, { log } = {}) {
  ensureDir(outDir);
  const pdfPath = path.join(outDir, "paper.pdf");
  log?.info(`下载 PDF：${pdfUrl}`);
  const res = await fetch(pdfUrl, {
    signal: AbortSignal.timeout(90_000),
    headers: { "User-Agent": "Mozilla/5.0 wechat-daily" },
  });
  if (!res.ok) throw new Error(`下载 PDF 失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(pdfPath, buf);
  log?.info(`PDF ${(buf.length / 1024).toFixed(0)}KB`);
  return pdfPath;
}

/** 抽取本地 PDF 的正文文字（给写作模型当依据） */
export async function readPdfText(pdfPath, { maxChars = 24_000, log } = {}) {
  const { stdout } = await run("pdftotext", ["-layout", "-nopgbrk", pdfPath, "-"], {
    timeout: 120_000,
    maxBuffer: 48 * 1024 * 1024,
  });
  let text = String(stdout)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 去掉参考文献之后的部分（对写作没有价值，还浪费上下文）
  const refIdx = text.search(/\n\s*(References|REFERENCES|参考文献)\s*\n/);
  if (refIdx > text.length * 0.4) text = text.slice(0, refIdx);

  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n\n[后文已截断]";
  log?.info(`PDF 文字：${text.length} 字符（约 ${text.length} 字节）`);
  return text;
}

/** 从本地 PDF 抽图（主流程） */
export async function extractFiguresFromFile(pdfPath, outDir, { log, max = 6 } = {}) {
  ensureDir(outDir);
  log?.info(`PDF 大小 ${(fs.statSync(pdfPath).size / 1024).toFixed(0)}KB`);

  // pdfimages 把 PDF 里所有位图按 -000, -001... 导出
  const prefix = path.join(outDir, "raw");
  await run("pdfimages", ["-png", "-f", "1", "-l", "30", pdfPath, prefix], {
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });

  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^raw-\d+\.png$/.test(f))
    .map((f) => path.join(outDir, f));
  log?.info(`抽出 ${files.length} 个位图，开始筛选`);

  const candidates = [];
  for (const f of files) {
    try {
      const meta = await sharp(f).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (w < 240 || h < 160) continue;
      const aspect = w / h;
      if (aspect < 0.28 || aspect > 3.4) continue;
      const size = fs.statSync(f).size;
      if (size < 12 * 1024) continue;

      // 判断是不是接近纯白（很多 "图" 其实是白底装饰）
      const stats = await sharp(f).stats();
      const mean = stats.channels.reduce((a, c) => a + c.mean, 0) / stats.channels.length;
      if (mean > 246) continue;
      candidates.push({ file: f, width: w, height: h, bytes: size, mean });
    } catch {
      /* 坏图直接跳过 */
    }
  }
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  log?.info(`尺寸筛选后剩 ${candidates.length} 张`);
  return candidates.slice(0, max);
}

/** 兼容旧调用：给个 URL，下回来再抽 */
export async function extractFigures(pdfUrl, outDir, { log, max = 5 } = {}) {
  const pdfPath = await downloadPdf(pdfUrl, outDir, { log });
  return extractFiguresFromFile(pdfPath, outDir, { log, max });
}

/* ---------------------------- 看图写注 ---------------------------- */

const CAPTION_PROMPT = `这是学术论文里的一张插图。请判断并回答：

如果不是图表（只是图标、公式碎片、排版装饰、作者照片），只回答两个字：非图表。

如果是图表，按这个格式输出两行：
说明：一到两句中文，说清它展示了什么；有坐标轴/曲线/色标就说明其含义和单位。
标题：一个 15 字以内的中文图注标题

不要客套话，直接从"说明："开始。`;

export async function captionFigure(file, { log } = {}) {
  const b64 = fs.readFileSync(file).toString("base64");
  const { content } = await chat({
    model: VISION_MODEL(),
    temperature: 0.3,
    maxTokens: 2500, // 视觉模型也是推理模型，给小了 content 会是空的
    timeoutMs: 180_000,
    tag: "paper.caption",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: CAPTION_PROMPT },
          { type: "image_url", image_url: { url: "data:image/png;base64," + b64 } },
        ],
      },
    ],
  });

  const text = content.trim();
  if (/^非图表/.test(text) || text.length < 10) {
    log?.info(`  ✗ ${path.basename(file)} 非图表`);
    return null;
  }
  const desc = text.match(/说明：\s*([\s\S]*?)(?:\n|$)/)?.[1]?.trim() ?? text.split("\n")[0];
  const title = text.match(/标题：\s*([\s\S]*?)(?:\n|$)/)?.[1]?.trim() ?? "";
  log?.info(`  ✓ ${path.basename(file)} ${title || desc.slice(0, 24)}`);
  return { file, caption: desc, title };
}

/* ---------------------------- 插入正文 ---------------------------- */

/**
 * 让模型决定每张图放在哪个小节之后。
 * @returns {Promise<Array<{file, caption, title, afterSection:number}>>}
 */
export async function placeFigures({ markdown, figures, log }) {
  const sections = [...markdown.matchAll(/^##\s+(.+)$/gm)].map((m, i) => `${i + 1}. ${m[1]}`);
  if (!sections.length || !figures.length) return [];

  const list = figures
    .map((f, i) => `${i + 1}. 图注：${f.title || f.caption.slice(0, 30)}｜内容：${f.caption.slice(0, 80)}`)
    .join("\n");

  const { content } = await (async () => {
    try {
      return await chat({
        model: env("OPENCODE_MODEL_FAST") || env("OPENCODE_MODEL"),
        temperature: 0.1,
        // deepseek-v4.1-flash 是推理模型，预算给小了会全花在 reasoning 上、
        // content 返回空。这里直接给 8000。
        maxTokens: 8000,
        tag: "paper.place",
        messages: [
          {
            role: "user",
            content: `文章的小节是：
${sections.join("\n")}

待插入的插图：
${list}

请给每张图指定它最应该跟在哪个小节之后（填小节序号；如果和全文都无关填 0）。
**不要写任何推理过程，直接输出 JSON 数组**：{"placements":[{"fig":1,"after":2}]}`,
          },
        ],
      });
    } catch (err) {
      log?.warn(`插图定位失败（${err.message}），全部放到文末`);
      return { content: "" };
    }
  })();

  let parsed;
  try {
    const m = content.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : "{}");
    parsed = Array.isArray(obj) ? obj : (obj.placements ?? []);
  } catch {
    log?.warn("插图定位解析失败，全部放到文末");
    parsed = [];
  }

  const map = new Map(parsed.map((p) => [Number(p.fig), Number(p.after)]));
  const result = [];
  figures.forEach((f, i) => {
    const after = map.get(i + 1);
    if (after === undefined || after === null || after < 0) return;
    result.push({ ...f, afterSection: after });
  });
  log?.info(`插图定位完成：${result.length}/${figures.length} 张找到位置`);
  return result;
}

/**
 * 把图片插进 markdown。afterSection 是 1-based 的小节序号（0 = 文末）。
 */
export function insertFigures(markdown, placed, { source = "" } = {}) {
  if (!placed.length) return markdown;

  const lines = markdown.split("\n");
  // 找出每个 ## 小节的起始行号
  const sectionStarts = [];
  lines.forEach((l, i) => {
    if (/^##\s+/.test(l)) sectionStarts.push(i);
  });

  const bySection = new Map();
  for (const f of placed) {
    const key = f.afterSection;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(f);
  }

  const imgMd = (f, idx) =>
    `![图${idx} ${f.title || ""}](${f.file})\n\n> 图 ${idx}：${f.caption}`;

  const out = [];
  let figNo = 0;

  // 文末图（afterSection = 0 或超出范围）
  const tailFigs = [];
  const putTail = (arr) => arr.forEach((f) => tailFigs.push(f));

  const emitFor = (key) => {
    const arr = bySection.get(key) ?? [];
    arr.forEach((f) => out.push("", imgMd(f, ++figNo), ""));
  };

  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const secIdx = sectionStarts.indexOf(i);
    if (secIdx !== -1) {
      continue; // 小节的图在该节结束处插入，见下
    }
    // 在下一个 ## 之前、或遇到本节的最后一行时插入 —— 简化处理：遇到下一个 ## 时处理上一节
    const nextIsHeading = /^##\s+/.test(lines[i + 1] ?? "");
    const secOfLine = sectionStarts.filter((s) => s <= i).length; // 当前行属于第几个小节
    if ((nextIsHeading || i === lines.length - 1) && !/^##\s+/.test(lines[i])) {
      emitFor(secOfLine);
    }
  }
  putTail(bySection.get(0) ?? []);
  const extra = [...bySection.entries()].filter(([k]) => k > sectionStarts.length).flatMap(([, v]) => v);
  extra.forEach((f) => tailFigs.push(f));

  if (tailFigs.length) {
    out.push("", "### 论文原图", "");
    tailFigs.forEach((f) => out.push(imgMd(f, ++figNo), ""));
  }

  if (source) {
    out.push("", `> 图片来源：${source}`);
  }
  return out.join("\n");
}

/* ---------------------------- 一站式入口 ---------------------------- */

/**
 * @returns {Promise<{markdown:string, paper:object|null, figures:number}>}
 */
export async function attachPaperFigures({ topic, markdown, outDir, log, max = 4 }) {
  try {
    const query = await toSearchQuery(topic, log);
    const papers = await findPapers(query, { log });
    if (!papers.length) {
      log?.warn("没搜到合适文献，跳过配图");
      return { markdown, paper: null, figures: 0 };
    }
    const paper = papers[0];

    const figDir = ensureDir(path.join(outDir, "figs"));
    const candidates = await extractFigures(paper.pdfUrl, figDir, { log, max: 8 });
    if (!candidates.length) {
      log?.warn("PDF 里没有可用的图");
      return { markdown, paper, figures: 0 };
    }

    const captioned = [];
    for (const c of candidates) {
      if (captioned.length >= max) break;
      try {
        const r = await captionFigure(c.file, { log });
        if (r) captioned.push(r);
      } catch (err) {
        log?.warn(`  看图失败 ${path.basename(c.file)}：${err.message}`);
      }
    }
    if (!captioned.length) {
      log?.warn("没有可用的图表（全是装饰性位图）");
      return { markdown, paper, figures: 0 };
    }

    const placed = await placeFigures({ markdown, figures: captioned, log });
    const source = `${paper.authors.slice(0, 3).join(", ")}${paper.authors.length > 3 ? " 等" : ""}，${paper.title}，arXiv:${paper.arxivId}${paper.published ? `, ${paper.published}` : ""}${paper.license ? `（${paper.license}）` : ""}`;

    const newMd = insertFigures(markdown, placed.length ? placed : captioned.map((f) => ({ ...f, afterSection: 0 })), {
      source,
    });

    return { markdown: newMd, paper, figures: captioned.length, source };
  } catch (err) {
    // 配图是增强项，任何环节失败都不该让整篇文章作废
    log?.error(`配图环节失败（继续无图发布）：${err.message}`);
    return { markdown, paper: null, figures: 0, error: err.message };
  }
}

/* ------------------- 用户直接发 PDF 过来的流程 ------------------- */

/** 从论文全文里提炼选题角度 */
export async function topicFromPaper(pdfText, { log } = {}) {
  const excerpt = pdfText.slice(0, 12_000);
  const { content } = await chat({
    model: env("OPENCODE_MODEL_FAST") || env("OPENCODE_MODEL"),
    temperature: 0.5,
    maxTokens: 3000,
    tag: "paper.topic",
    messages: [
      {
        role: "user",
        content: `下面是一篇论文的开头部分。请为它设计一个公众号选题。

【论文开头】
${excerpt}

请输出 JSON：
{
  "paper_title": "论文原标题（英文就保留英文）",
  "topic": "给中文读者的一句话选题（20字内），不要照抄标题，要说清楚这篇真正解决了什么问题",
  "angle": "你打算怎么写（60字内）：从哪个具体问题切入，读者能得到什么判断",
  "audience_value": "为什么值得一个工程师/研究生花 5 分钟读（30字内）"
}`,
      },
    ],
  });
  const m = content.match(/[{[]/);
  const j = m ? safeJson(content.slice(m.index)) : null;
  if (!j?.topic) throw new Error("从论文提炼选题失败");
  log?.info(`论文：《${j.paper_title ?? "?"}》`);
  log?.info(`选题：${j.topic}`);
  return {
    paperTitle: j.paper_title ?? "",
    topic: j.topic,
    angle: j.angle ?? "",
    why: j.audience_value ?? "",
    source: "paper",
  };
}

function safeJson(s) {
  try {
    const start = s.search(/[{[]/);
    const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 从用户发来的 PDF 抽图并配进正文。
 * 和 attachPaperFigures 的区别：文献是用户指定的，不需要检索。
 */
export async function attachFiguresFromFile({ pdfPath, markdown, outDir, paperMeta = {}, log, max = 4 }) {
  try {
    const figDir = ensureDir(path.join(outDir, "figs"));
    const candidates = await extractFiguresFromFile(pdfPath, figDir, { log, max: 8 });
    if (!candidates.length) {
      log?.warn("PDF 里没有可用的位图（可能是矢量图），本篇不配图");
      return { markdown, figures: 0 };
    }

    const captioned = [];
    for (const c of candidates) {
      if (captioned.length >= max) break;
      try {
        const r = await captionFigure(c.file, { log });
        if (r) captioned.push(r);
      } catch (err) {
        log?.warn(`  看图失败 ${path.basename(c.file)}：${err.message}`);
      }
    }
    if (!captioned.length) {
      log?.warn("没有可用的图表（全是装饰性位图）");
      return { markdown, figures: 0 };
    }

    const placed = await placeFigures({ markdown, figures: captioned, log });
    const source =
      paperMeta.paperTitle || paperMeta.title
        ? `${paperMeta.paperTitle ?? paperMeta.title}${paperMeta.authors ? `，${paperMeta.authors}` : ""}（用户提供的 PDF）`
        : "用户提供的论文 PDF";

    const newMd = insertFigures(
      markdown,
      placed.length ? placed : captioned.map((f) => ({ ...f, afterSection: 0 })),
      { source }
    );
    return { markdown: newMd, figures: captioned.length, paper: { ...paperMeta, sourceLabel: source } };
  } catch (err) {
    log?.error(`配图环节失败（继续无图发布）：${err.message}`);
    return { markdown, figures: 0, error: err.message };
  }
}
