/**
 * 跑流水线并把结果回报给用户。
 *
 * 用 spawn 而不是直接 import，是因为主流程是给定时任务用的 CLI，
 * 它自己会 process.exit()，放进 bot 进程里会一起被杀掉。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../env.js";
import { dateInTZ, readJson } from "../util.js";
import { setPhase, loadBotState } from "./state.js";
import { sendProactive } from "./channel.js";

export function pipelineRunning() {
  return loadBotState().phase === "generating";
}

/**
 * @param {object} o
 * @param {string} o.topic  选题（原文）
 * @param {string} [o.brief] 额外要求
 * @param {boolean} [o.force] 今天已生成过也重跑
 * @param {string} [o.toUser]
 */
export function startPipeline({ topic, brief, force = false, toUser, paper = false, fromPaper = null }) {
  const dateStr = dateInTZ("Asia/Shanghai");
  const logDir = path.join(ROOT, "data", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `bot-${dateStr}-${Date.now()}.log`);

  const args = [path.join(ROOT, "src", "main.js")];
  if (topic) args.push(`--topic=${topic}`);
  if (brief && brief.trim()) args.push(`--brief=${brief.trim()}`);
  if (paper) args.push("--paper=auto");
  if (fromPaper) args.push(`--from-paper=${fromPaper}`);
  if (force) args.push("--force");

  // 子进程输出直接落文件，方便事后排查
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: false,
    stdio: ["ignore", out, out],
    env: { ...process.env, TZ: "Asia/Shanghai" },
  });

  setPhase("generating", {
    date: dateStr,
    topic: topic || "你发来的论文",
    brief: brief ?? "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastSummary: null,
    logFile,
  });

  child.on("exit", async (code) => {
    fs.closeSync(out);
    const metaPath = path.join(ROOT, "data", "out", dateStr, "meta.json");
    const meta = readJson(metaPath, null);

    let msg;
    if (code === 0 && meta?.wechat?.draftMediaId) {
      msg =
        `✅ 已进草稿箱\n\n` +
        `《${meta.plan.title}》\n` +
        `${meta.words} 字 · 封面《${meta.plan.cover_title ?? ""}》\n\n` +
        `→ 打开「订阅号助手」App 或 mp.weixin.qq.com 草稿箱，确认后点「群发」。\n` +
        `（发送「状态」可随时查看，发送「重写 你的要求」可以再来一版）`;
    } else if (code === 2 || meta?.wechat?.error) {
      msg =
        `⚠️ 文章写好了，但进草稿箱失败\n\n` +
        `《${meta?.plan?.title ?? topic}》 ${meta?.words ?? "?"} 字\n` +
        `原因：${meta?.wechat?.error ?? "未知"}\n\n` +
        `产物在 data/out/${dateStr}/，修好后可用 push.js 补推。`;
    } else if (code === 0) {
      msg = `已完成，但没拿到草稿 media_id（可能跑了 dry-run）。产物在 data/out/${dateStr}/。`;
    } else {
      msg =
        `❌ 生成失败（退出码 ${code}）\n\n` +
        `选题：${topic}\n` +
        `日志：${path.relative(ROOT, logFile)}\n\n` +
        `发送「重试」可以再来一次。`;
    }

    setPhase("idle", {
      endedAt: new Date().toISOString(),
      lastSummary: msg,
      lastExitCode: code,
    });

    try {
      await sendProactive(msg);
    } catch (err) {
      // 通知发不出去不能影响状态机，但要让日志里有
      console.error(`[runner] 完成通知发送失败：${err.message}`);
    }
  });

  child.on("error", (err) => {
    setPhase("idle", { endedAt: new Date().toISOString(), lastSummary: `启动失败：${err.message}` });
  });

  return { logFile, dateStr };
}
