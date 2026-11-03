#!/usr/bin/env node
/**
 * 一次生成多个封面方案，供人挑选。
 *
 *   node src/tools/cover.js                     给今天那一篇生成 3 个方案
 *   node src/tools/cover.js --date=2026-11-05 --n=4
 *   node src/tools/cover.js --titles="标题A|标题B|标题C"
 *
 * 输出到 data/out/<date>/covers/，并在最后打印路径清单。
 * 想让人在微信里直接看到，把这些文件复制到 data/outbox/ 即可。
 */

import fs from "node:fs";
import path from "node:path";

import { ROOT, loadEnv } from "../env.js";
import { readYaml, dateInTZ, readJson, ensureDir } from "../util.js";
import { renderCover, pickTheme } from "../cover.js";

loadEnv();

const argv = process.argv.slice(2);
const val = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const site = readYaml("config/site.yaml");
const dateStr = val("date") ?? dateInTZ(site.timezone ?? "Asia/Shanghai");
const N = Number(val("n") ?? 3);
const BASE_IMG = val("base");            // 用哪张图当封面底图（论文里的图）
const BASE_DIR = val("figs");             // 或者：自动从某个 figs 目录里挑

const outDir = path.join(ROOT, "data", "out", dateStr);
const meta = readJson(path.join(outDir, "meta.json"), {});
const plan = meta?.plan ?? {};

// 候选文案：优先用封面标题，其次正标题，最后摘要
const candidates = (val("titles") ? val("titles").split("|") : [
  plan.cover_title,
  plan.title,
  plan.digest ? String(plan.digest).slice(0, 16) : null,
]).filter(Boolean);

if (!candidates.length) {
  console.error(`没找到标题。请先跑 node src/main.js --date=${dateStr}，或用 --titles="A|B|C" 指定。`);
  process.exit(1);
}

const themes = ["ink", "dawn", "forest", "clay", "slate"];
const coverDir = ensureDir(path.join(outDir, "covers"));
const made = [];

for (let i = 0; i < N; i++) {
  const title = candidates[i % candidates.length];
  const theme = themes[(pickThemeIndex(dateStr) + i) % themes.length];
  const out = path.join(coverDir, `v${i + 1}-${theme}.png`);
  const baseImage = BASE_IMG || autoPickBase(i);
  const c = await renderCover({
    baseImage,
    title,
    date: dateStr,
    kicker: site.cover?.kicker ?? "",
    brand: site.account?.name ?? "",
    theme,
    size: { width: site.cover?.width ?? 900, height: site.cover?.height ?? 383 },
    out,
  });
  made.push({ file: out, title, theme, fontSize: c.fontSize });
  console.log(`v${i + 1}  ${theme.padEnd(7)} ${title}`);
}

console.log("\n生成完成：");
for (const m of made) console.log(path.relative(ROOT, m.file));

// 打印成 JSON 方便 agent 解析
if (argv.includes("--json")) {
  console.log(JSON.stringify({ covers: made.map((m) => path.relative(ROOT, m.file)) }));
}

/** 没指定 --base 时，从 --figs 目录里按顺序挑图 */
function autoPickBase(i) {
  if (!BASE_DIR) return null;
  const dir = path.isAbsolute(BASE_DIR) ? BASE_DIR : path.join(ROOT, BASE_DIR);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /.(png|jpe?g)$/i.test(f)).sort();
  if (!files.length) return null;
  return path.join(dir, files[i % files.length]);
}

function pickThemeIndex(date) {
  const names = themes;
  const n = date.split("-").reduce((a, b) => a + Number(b), 0);
  return n % names.length;
}
