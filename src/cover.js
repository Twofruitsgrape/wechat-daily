/**
 * 封面图生成：纯本地 SVG -> PNG（sharp），不依赖任何生图 API。
 * 微信主封面规格 900x383（2.35:1），PNG < 2MB。
 */

import sharp from "sharp";
import path from "node:path";
import { ensureDir } from "./util.js";

const THEMES = {
  ink: { from: "#111c33", to: "#2b3a67", accent: "#4f7cff", text: "#ffffff", sub: "#cfd8ea" },
  dawn: { from: "#7a1c3c", to: "#d94f4f", accent: "#ffb238", text: "#ffffff", sub: "#ffe3d0" },
  forest: { from: "#0f3b2e", to: "#2f7d5f", accent: "#7fd4a8", text: "#ffffff", sub: "#cfeee0" },
  clay: { from: "#3a2b23", to: "#8c5a3c", accent: "#e8a35c", text: "#ffffff", sub: "#f2ddc9" },
  slate: { from: "#232526", to: "#414345", accent: "#9fa8b3", text: "#ffffff", sub: "#c9ced6" },
};

const THEME_ORDER = ["ink", "dawn", "forest", "clay", "slate"];

// 优先用 Noto CJK（Linux 服务器常见），再退到各平台自带中文字体
const FONT = "Noto Sans CJK SC, Noto Sans SC, Microsoft YaHei, PingFang SC, Heiti SC, sans-serif";

export function pickTheme(name, dateStr) {
  if (name && name !== "auto" && THEMES[name]) return name;
  // 按日期轮换，每天视觉上有点变化
  const n = dateStr.split("-").reduce((a, b) => a + Number(b), 0);
  return THEME_ORDER[n % THEME_ORDER.length];
}

/** 估算字符宽度（以 em 为单位）：中文/全角约 1em，西文约 0.55em */
function charEm(ch) {
  if (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch)) {
    return 1.0;
  }
  if (ch === " ") return 0.3;
  if (/[iIl1.,:;'!|]/.test(ch)) return 0.3;
  if (/[A-Z0-9mwMW]/.test(ch)) return 0.66;
  return 0.55;
}

/** 按可用宽度把标题折成若干行，必要时二次折行避免超长单词 */
function wrapTitle(text, maxEm) {
  const out = [];
  let line = "";
  let w = 0;
  for (const ch of text) {
    const cw = charEm(ch);
    if (w + cw > maxEm && line) {
      out.push(line);
      line = ch;
      w = cw;
    } else {
      line += ch;
      w += cw;
    }
  }
  if (line) out.push(line);

  // 避头点：中文标点不能出现在行首（否则会出现“，卡在…”这种断句）
  // 做法是把它“悬挂”到上一行末尾，允许该行略超一点宽
  const NO_LINE_START = "、，。；：？！）》」』】〕…·,.;:?!)]}";
  for (let i = 1; i < out.length; i++) {
    let guard = 0;
    while (out[i] && NO_LINE_START.includes(out[i][0]) && guard < 3) {
      out[i - 1] += out[i][0];
      out[i] = out[i].slice(1);
      guard++;
    }
  }
  return out.filter((l) => l.length > 0);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {object} o
 * @param {string} o.title      封面主标题（一般 8-20 字）
 * @param {string} o.date       2026-10-29
 * @param {string} o.kicker     左上角小字，可为空
 * @param {string} o.brand      右下角署名，可为空
 * @param {string} o.theme      ink|dawn|forest|clay|slate|auto
 * @param {object} o.size       {width,height}
 * @param {string} o.out       输出 png 绝对路径
 */
export async function renderCover(o) {
  const W = o.size?.width ?? 900;
  const H = o.size?.height ?? 383;
  const themeName = pickTheme(o.theme, o.date ?? "2026-01-01");
  const t = THEMES[themeName];

  const pad = Math.round(W * 0.075);
  const maxEm = o.baseImage ? W * 0.465 : W - pad * 2; // 有底图时标题只在左侧面板内排
  const kicker = (o.kicker ?? "").trim();
  const title = (o.title ?? "").trim() || "每日一篇";

  // 标题里可以用 \n 指定硬换行（避免把“效率”这种词劈成两行）
  const wrapAll = (text, maxEm) =>
    String(text)
      .split("\n")
      .flatMap((seg) => wrapTitle(seg, maxEm))
      .filter((l) => l.trim().length > 0);

  // 依次尝试字号，找第一个能放进 3 行内的
  const sizes = [Math.round(H * 0.155), Math.round(H * 0.135), Math.round(H * 0.115), Math.round(H * 0.098), Math.round(H * 0.082)];
  let fontSize = sizes[0];
  let lines = [];
  const maxLines = title.includes("\n") ? Math.max(3, title.split("\n").length) : 3;
  for (const fs of sizes) {
    const wrapped = wrapAll(title, maxEm / fs);
    if (wrapped.length <= maxLines) {
      fontSize = fs;
      lines = wrapped;
      break;
    }
    fontSize = fs;
    lines = wrapAll(title, maxEm / fs).slice(0, maxLines);
  }

  const lineH = fontSize * 1.35;
  const blockH = lines.length * lineH;
  const kickerH = kicker ? Math.round(H * 0.075) : 0;
  const contentH = blockH + (kicker ? kickerH + 18 : 0);
  const startY = (H - contentH) / 2 + fontSize * 0.82 + kickerH + (kicker ? 18 : 0);

  const titleSvg = lines
    .map(
      (ln, idx) =>
        `<text x="${pad}" y="${Math.round(startY + idx * lineH)}" font-family="${FONT}" font-size="${fontSize}" font-weight="700" fill="${t.text}" letter-spacing="1">${esc(ln)}</text>`
    )
    .join("");

  const kickerSvg = kicker
    ? `<text x="${pad}" y="${pad + Math.round(kickerH * 0.72)}" font-family="${FONT}" font-size="${Math.round(H * 0.05)}" font-weight="500" fill="${t.accent}" letter-spacing="3">${esc(kicker)}</text>`
    : "";

  // 左侧竖条：对齐标题字块的上沿到下沿
  const barTop = startY - fontSize * 0.82;
  const barH = (lines.length - 1) * lineH + fontSize * 1.06;

  const brand = (o.brand ?? "").trim();
  const brandSvg = brand
    ? `<text x="${pad}" y="${H - Math.round(H * 0.09)}" text-anchor="start" font-family="${FONT}" font-size="${Math.round(H * 0.045)}" fill="${t.sub}" opacity="0.85">${esc(brand)}</text>`
    : "";

  const dateSvg = o.date
    ? `<text x="${W - pad}" y="${H - Math.round(H * 0.09)}" text-anchor="end" font-family="${FONT}" font-size="${Math.round(H * 0.045)}" fill="${t.sub}" opacity="0.8">${esc(o.date)}</text>`
    : "";

  // 带底图时日期放左侧面板，否则会压在论文原图的文字上、根本看不清
  const dateSvgLeft = o.date
    ? `<text x="${pad}" y="${H - Math.round(H * 0.075)}" text-anchor="start" font-family="${FONT}" font-size="${Math.round(H * 0.042)}" fill="${t.sub}" opacity="0.72">${esc(o.date)}</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${t.from}"/>
      <stop offset="100%" stop-color="${t.to}"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.22"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  <circle cx="${W - Math.round(W * 0.09)}" cy="${Math.round(H * 0.16)}" r="${Math.round(W * 0.14)}" fill="${t.accent}" opacity="0.13"/>
  <circle cx="${Math.round(W * 0.06)}" cy="${H - Math.round(H * 0.08)}" r="${Math.round(W * 0.07)}" fill="${t.accent}" opacity="0.10"/>
  <rect x="${pad - Math.round(W * 0.022)}" y="${Math.round(barTop)}" width="${Math.round(W * 0.008)}" height="${Math.round(barH)}" fill="${t.accent}" opacity="0.9" rx="3"/>
  ${kickerSvg}
  ${titleSvg}
  ${brandSvg}
  ${dateSvg}
</svg>`;

  ensureDir(path.dirname(o.out));

  // 带底图模式：左边做纯色文字区，右边留出论文原图（原图保持亮度，不整张压暗）
  if (o.baseImage) {
    const seam = Math.round(W * 0.52);
    const fade = Math.round(W * 0.12); // 接缝处的过渡宽度

    // 底图：只轻微提亮/去饱和，让它看起来像素材而不是截图
    const base = await sharp(o.baseImage)
      .resize(Math.round(W * 0.62), H, { fit: "cover", position: "right" })
      .modulate({ brightness: 1.04, saturation: 0.85 })
      .extend({ top: 0, bottom: 0, left: W - Math.round(W * 0.62), right: 0, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();

    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="panel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${t.from}" stop-opacity="1"/>
          <stop offset="${Math.round((seam / (seam + fade)) * 100)}%" stop-color="${t.from}" stop-opacity="0.97"/>
          <stop offset="100%" stop-color="${t.from}" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="rightVeil" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${seam + fade}" height="${H}" fill="url(#panel)"/>
      <rect x="${seam + fade}" y="0" width="${W - seam - fade}" height="${H}" fill="url(#rightVeil)"/>
      <rect x="${seam}" y="0" width="3" height="${H}" fill="${t.accent}" opacity="0.85"/>
      ${kickerSvg}
      ${titleSvg}
      ${dateSvgLeft}
    </svg>`);

    await sharp(base)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png({ compressionLevel: 9 })
      .toFile(o.out);

    const m2 = await sharp(o.out).metadata();
    return { path: o.out, width: m2.width, height: m2.height, theme: themeName, fontSize, lines, baseImage: true };
  }

  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(o.out);
  const meta = await sharp(o.out).metadata();
  return { path: o.out, width: meta.width, height: meta.height, theme: themeName, fontSize, lines };
}
