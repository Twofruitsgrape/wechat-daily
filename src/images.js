/**
 * 正文配图上传：把 markdown 里引用的本地图片传到微信 CDN 并替换成 mmbiz 地址。
 *
 * 为什么单独抽出来：main.js（正常流程）和 push.js（补推）都要用，
 * 复制两份迟早会改漏。
 *
 * 为什么按行处理而不是正则替换：insertFigures 生成的结构是
 *      ![图1 xxx](路径)
 *      （空行）
 *      > 图 1：说明
 * 图片传失败时必须把「图注」也一起删掉，否则文章里会剩下一句
 * 「图 1：xxx」却看不到图。按行扫最容易做到这一点。
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.js";
import * as wx from "./wechat.js";

const IMG_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const CAPTION_LINE = /^>\s*图\s*\d+：/;

export async function uploadLocalImages(md, logger, { max = 8 } = {}) {
  const lines = String(md).split("\n");
  const out = [];

  let quotaHit = false;
  let failed = 0;
  let uploaded = 0;
  let skippedLocal = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(IMG_LINE);
    const isLocal = m && !/^https?:\/\//i.test(m[2]) && !m[2].startsWith("data:");

    if (!isLocal) {
      out.push(line);
      continue;
    }

    const rel = m[2];
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    const name = path.basename(rel);

    // 决定这张图能不能留下
    let replacement = null;
    if (uploaded >= max) {
      logger.warn(`正文图超过上限 ${max} 张，丢弃：${name}`);
    } else if (quotaHit) {
      logger.warn(`配额受限，丢弃剩余图片：${name}`);
    } else if (!fs.existsSync(abs)) {
      logger.warn(`正文引用了不存在的图片，已移除：${name}`);
    } else {
      try {
        const url = await wx.uploadContentImage(fs.readFileSync(abs), name);
        replacement = `![${m[1]}](${url})`;
        uploaded += 1;
        logger.info(`正文图已上传：${name} -> ${url.slice(0, 56)}…`);
      } catch (err) {
        failed += 1;
        if (err.code === 45009) quotaHit = true;
        logger.warn(`正文图上传失败，已从正文移除：${name} :: ${String(err.message).split("\n")[0]}`);
      }
    }

    if (replacement) {
      out.push(replacement);
      continue;
    }

    // 这张图不要了：跳过它后面的空行和图注
    skippedLocal += 1;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j < lines.length && CAPTION_LINE.test(lines[j])) {
      i = j; // 连图注一起吃掉
    }
  }

  let result = out.join("\n").replace(/\n{3,}/g, "\n\n");
  // 如果全部图都被删了，顺手删掉空的「### 论文原图」标题和图片来源行
  if (skippedLocal && !/!\[[^\]]*\]\([^)]*\)/.test(result)) {
    result = result
      .replace(/\n*###\s*论文原图\s*\n/g, "\n")
      .replace(/\n*>?\s*图片来源：[^\n]*\n?/g, "\n");
    logger.warn("所有正文配图均未能上传，已移除配图小节");
  }

  if (failed) logger.warn(`共 ${failed} 张图未能上传，已从正文移除`);
  if (uploaded) logger.info(`正文图成功上传 ${uploaded} 张`);
  return result;
}
