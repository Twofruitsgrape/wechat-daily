/**
 * Markdown -> 微信公众号安全 HTML
 *
 * 为什么不用 marked / markdown-it：
 *   1. 微信会剥掉 <style>、class、id，所有样式必须内联在 style="" 里，
 *      第三方渲染器的输出得再做一轮 DOM 后处理，反而更绕；
 *   2. 个人主体订阅号的正文外链不可点击，需要把链接改写成「正文纯文本 + 文末引用」，
 *      这是自定义规则，标准渲染器没有。
 *
 * 支持：标题、段落、粗体、斜体、行内代码、代码块、引用、有序/无序列表（可嵌套）、
 *      表格、分割线、图片、链接（按 link_mode 处理）
 */

import { escapeHtml } from "./util.js";

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const MONO_STACK = "Menlo,Consolas,'Courier New',monospace";

function buildStyles(t = {}) {
  const fs = t.font_size ?? 16;
  const lh = t.line_height ?? 1.8;
  const ls = t.letter_spacing ?? 0.5;
  const text = t.text_color ?? "#3f3f3f";
  const head = t.heading_color ?? "#1a1a1a";
  const accent = t.accent_color ?? "#0e7c86";
  const hl = t.highlight_color ?? accent;
  const justify = t.justify !== false ? "text-align:justify;text-justify:inter-ideograph;" : "";

  return {
    root: `font-size:${fs}px;color:${text};line-height:${lh};letter-spacing:${ls}px;font-family:${FONT_STACK};word-break:break-word;${justify}`,
    p: `margin:0 0 1.35em 0;font-size:${fs}px;line-height:${lh};letter-spacing:${ls}px;color:${text};${justify}`,
    h1: `margin:1.8em 0 0.9em;font-size:${fs + 6}px;line-height:1.4;font-weight:700;color:${head};letter-spacing:0;text-align:left;`,
    h2Title: `margin:0 0 10px;font-size:${fs + 3}px;line-height:1.45;font-weight:700;color:${head};letter-spacing:0.5px;text-align:left;`,
    h2Num: `margin:0 0 6px;font-size:${fs - 3}px;line-height:1.2;font-weight:600;color:${accent};letter-spacing:3px;text-align:left;`,
    h2Rule: `height:1px;background:linear-gradient(to right,${accent}88,${accent}00);`,
    h3: `margin:1.6em 0 0.7em;font-size:${fs + 1}px;line-height:1.5;font-weight:700;color:${head};letter-spacing:0.5px;text-align:left;`,
    h4: `margin:1.3em 0 0.6em;font-size:${fs}px;line-height:1.5;font-weight:700;color:${head};`,
    highlight: `color:${hl};font-weight:600;`,
    strong: `font-weight:600;color:${head};`,
    em: `font-style:italic;color:${text};`,
    del: `text-decoration:line-through;opacity:0.7;`,
    quote: `margin:1.4em 0;padding:12px 16px;background:${t.quote_bg ?? "#f7f7f7"};border-left:3px solid ${t.quote_border ?? "#d8d8d8"};color:#6b6b6b;font-size:${fs - 1}px;line-height:1.75;`,
    quoteP: `margin:0.4em 0;font-size:${fs - 1}px;line-height:1.75;color:#6b6b6b;`,
    caption: `margin:0.5em 0 1.9em;text-align:center;font-size:${fs - 3}px;line-height:1.7;color:#9099a6;letter-spacing:0.2px;`,
    ul: `margin:0 0 1.35em;padding-left:1.4em;list-style-type:disc;`,
    ol: `margin:0 0 1.35em;padding-left:1.4em;list-style-type:decimal;`,
    li: `margin:0.5em 0;font-size:${fs}px;line-height:${lh};color:${text};`,
    codeInline: `padding:2px 5px;margin:0 2px;background:${t.inline_code_bg ?? "#f2f3f5"};border-radius:3px;font-family:${MONO_STACK};font-size:${fs - 2}px;color:${t.inline_code_color ?? "#c7254e"};`,
    pre: `margin:1.4em 0;padding:14px 16px;background:${t.code_bg ?? "#282c34"};border-radius:6px;overflow-x:auto;font-size:${fs - 3}px;line-height:1.65;color:${t.code_color ?? "#abb2bf"};font-family:${MONO_STACK};white-space:pre;`,
    preCode: `font-family:${MONO_STACK};font-size:${fs - 3}px;line-height:1.65;color:${t.code_color ?? "#abb2bf"};background:none;padding:0;`,
    table: `margin:1.4em 0;width:100%;border-collapse:collapse;font-size:${fs - 2}px;line-height:1.6;`,
    th: `padding:8px 10px;border:1px solid #e2e2e2;background:#f6f6f6;font-weight:700;color:#2b2b2b;text-align:left;`,
    td: `padding:8px 10px;border:1px solid #e2e2e2;color:${text};`,
    img: `max-width:100%;height:auto;display:block;margin:1.7em auto 0.4em;border-radius:4px;`,
    hr: `margin:2.2em 0;border:none;border-top:1px solid #eaeaea;`,
    link: `color:${accent};text-decoration:none;`,
    footnote: `margin:2em 0 1em;padding-top:1em;border-top:1px dashed #e0e0e0;font-size:${fs - 2}px;line-height:1.7;color:#888;`,
    footnoteLi: `margin:0.35em 0;font-size:${fs - 2}px;line-height:1.7;color:#888;word-break:break-all;`,
  };
}

/* ------------------------------- 行内 ------------------------------- */

/** 中英文/数字之间自动加空格（pangu 规则），中文排版的基本功 */
function pangu(s) {
  return String(s)
    .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, "$1 $2")
    .replace(/([A-Za-z0-9%\u2103])([\u4e00-\u9fa5])/g, "$1 $2");
}

function esc(text, ctx) {
  const t = ctx.pangu ? pangu(text) : text;
  return escapeHtml(t);
}

function renderInline(raw, ctx) {
  if (!raw) return "";
  // 一次性扫描所有行内结构；未匹配到的片段才做 HTML 转义
  const RE = /(`[^`]+`)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))|(==[^=]+==)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~~[^~]+~~)/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = RE.exec(raw)) !== null) {
    out += esc(raw.slice(last, m.index), ctx);
    const tok = m[0];
    if (tok.startsWith("`")) {
      out += `<code style="${ctx.s.codeInline}">${escapeHtml(tok.slice(1, -1))}</code>`;
    } else if (tok.startsWith("![")) {
      const mm = tok.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      out += renderImage(mm?.[1] ?? "", mm?.[2] ?? "", ctx);
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out += renderLink(mm?.[1] ?? "", mm?.[2] ?? "", ctx);
    } else if (tok.startsWith("==")) {
      out += `<span style="${ctx.s.highlight}">${renderInline(tok.slice(2, -2), ctx)}</span>`;
    } else if (tok.startsWith("**")) {
      out += `<strong style="${ctx.s.strong}">${renderInline(tok.slice(2, -2), ctx)}</strong>`;
    } else if (tok.startsWith("~~")) {
      out += `<span style="${ctx.s.del}">${renderInline(tok.slice(2, -2), ctx)}</span>`;
    } else {
      out += `<em style="${ctx.s.em}">${renderInline(tok.slice(1, -1), ctx)}</em>`;
    }
    last = m.index + tok.length;
  }
  out += esc(raw.slice(last), ctx);
  return out;
}

function renderImage(alt, src, ctx) {
  const clean = src.replace(/\s+["'][^"']*["']$/, "").trim();
  if (!clean) return "";
  return `<img src="${escapeHtml(clean)}" alt="${escapeHtml(alt)}" style="${ctx.s.img}" />`;
}

function renderLink(text, url, ctx) {
  const target = url.split(/\s+/)[0];
  // 公众号内部链接、锚点保留为链接；外链按 link_mode 处理
  const isInternal = /^(#|https?:\/\/mp\.weixin\.qq\.com)/.test(target);
  if (ctx.linkMode === "anchor" || isInternal) {
    return `<a href="${escapeHtml(target)}" style="${ctx.s.link}">${renderInline(text, ctx)}</a>`;
  }
  // 个人号正文外链不可点：正文留文字，链接收到文末
  let idx = ctx.footnotes.findIndex((f) => f.url === target);
  if (idx === -1) {
    ctx.footnotes.push({ url: target, text });
    idx = ctx.footnotes.length - 1;
  }
  return `${renderInline(text, ctx)}<sup style="color:#999;font-size:12px;">[${idx + 1}]</sup>`;
}

/* ------------------------------- 块级 ------------------------------- */

const isBlank = (l) => /^\s*$/.test(l);
const FENCE = /^\s*```(\w*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function startsBlock(line) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST.test(line)
  );
}

export function renderWechat(markdown, theme = {}, opts = {}) {
  const s = buildStyles(theme);
  const ctx = {
    s,
    footnotes: [],
    linkMode: theme.link_mode ?? "text",
    pangu: theme.pangu !== false,
    h2count: 0,
  };

  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // 代码块
    const fence = line.match(FENCE);
    if (fence) {
      const lang = fence[1] || "";
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过结束围栏
      out.push(
        `<pre style="${s.pre}"><code style="${s.preCode}">${escapeHtml(buf.join("\n"))}</code></pre>`
      );
      continue;
    }

    // 标题
    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      let text = h[2];

      // 二级标题：编号 + 标题 + 渐变分割线（参考机器之心/可能吧的层次做法）
      if (level === 2) {
        ctx.h2count += 1;
        let num = String(ctx.h2count).padStart(2, "0");
        const m2 = text.match(/^\s*(\d+(?:\.\d+)*)[.、．)\s]+\s*(.*)$/);
        if (m2) {
          num = m2[1].padStart(2, "0");
          text = m2[2];
        }
        out.push(
          `<section style="margin:2.3em 0 1.15em;"><section style="${s.h2Num}">${num}</section><h2 style="${s.h2Title}">${renderInline(text, ctx)}</h2><section style="${s.h2Rule}"></section></section>`
        );
        i++;
        continue;
      }

      const tag = level === 1 ? "h1" : level === 3 ? "h3" : "h4";
      const styleKey = level === 1 ? "h1" : level === 3 ? "h3" : "h4";
      out.push(`<${tag} style="${s[styleKey]}">${renderInline(text, ctx)}</${tag}>`);
      i++;
      continue;
    }

    // 分割线
    if (HR.test(line)) {
      out.push(`<hr style="${s.hr}" />`);
      i++;
      continue;
    }

    // 引用（连续多行合并成一段）
    if (QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      const joined = buf.join("\n");

      // 以「图 1：」开头的引用块其实是图注，用小字居中灰字，不要做成灰底引用框
      if (/^图\s*\d+\s*[：:]/.test(joined.trim())) {
        out.push(`<p style="${s.caption}">${renderInline(joined.replace(/\n/g, " "), ctx)}</p>`);
        continue;
      }

      const inner = joined
        .split(/\n{2,}/)
        .map((chunk) => `<p style="${s.quoteP}">${renderInline(chunk.replace(/\n/g, " "), ctx)}</p>`)
        .join("");
      out.push(`<blockquote style="${s.quote}">${inner}</blockquote>`);
      continue;
    }

    // 表格
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const parseRow = (row) =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${header
        .map((c) => `<th style="${s.th}">${renderInline(c, ctx)}</th>`)
        .join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (r) =>
            `<tr>${r.map((c) => `<td style="${s.td}">${renderInline(c, ctx)}</td>`).join("")}</tr>`
        )
        .join("")}</tbody>`;
      out.push(`<table style="${s.table}">${thead}${tbody}</table>`);
      continue;
    }

    // 列表（支持缩进嵌套）
    if (LIST.test(line)) {
      const items = [];
      while (i < lines.length && (LIST.test(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i]) && !startsBlock(lines[i])))) {
        const lm = lines[i].match(LIST);
        if (lm) {
          items.push({
            indent: lm[1].replace(/\t/g, "    ").length,
            ordered: /\d/.test(lm[2]),
            text: lm[3],
          });
        } else if (items.length) {
          // 列表项的续行
          items[items.length - 1].text += " " + lines[i].trim();
        }
        i++;
      }
      out.push(renderList(items, ctx));
      continue;
    }

    // 段落：吃到空行或下一个块级结构为止
    const buf = [];
    while (i < lines.length && !isBlank(lines[i]) && (buf.length === 0 || !startsBlock(lines[i]))) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p style="${s.p}">${renderInline(buf.join(" "), ctx)}</p>`);
  }

  // 文末脚注
  if (ctx.footnotes.length && theme.link_mode !== "anchor") {
    const list = ctx.footnotes
      .map((f, idx) => `<p style="${s.footnoteLi}">[${idx + 1}] ${escapeHtml(f.url)}</p>`)
      .join("");
    out.push(`<section style="${s.footnote}"><p style="${s.footnoteLi}">文中提到的外部链接</p>${list}</section>`);
  }

  return {
    html: `<section style="${s.root}">${out.join("\n")}</section>`,
    footnotes: ctx.footnotes,
  };
}

function renderList(items, ctx) {
  let i = 0;

  // 按缩进递归重建嵌套层级
  function build(indent) {
    const ordered = items[i].ordered;
    const lis = [];
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) break; // 更深一层交给递归
      const it = items[i];
      i++;
      const children =
        i < items.length && items[i].indent > indent ? build(items[i].indent) : "";
      lis.push(`<li style="${ctx.s.li}">${renderInline(it.text, ctx)}${children}</li>`);
    }
    const tag = ordered ? "ol" : "ul";
    const style = ordered ? ctx.s.ol : ctx.s.ul;
    return `<${tag} style="${style}">${lis.join("")}</${tag}>`;
  }

  const parts = [];
  while (i < items.length) parts.push(build(items[i].indent));
  return parts.join("");
}

/** 粗略估计微信正文长度（微信限制约 20000 字符） */
export function estimateHtmlLength(html) {
  return html.length;
}
