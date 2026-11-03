/**
 * 把企业微信消息转给本机的 pi agent 处理。
 *
 * 为什么要这一层：之前的机器人只会匹配口令（「状态」「取消」），
 * 说复杂一点的要求它就不懂了。现在把整段话交给 pi —— 它有 bash/read/write/edit
 * 工具，能自己判断该跑哪个命令、该改哪个文件。
 *
 * 进程隔离：pi 作为子进程跑，崩了不会带崩机器人；超时直接 kill。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ROOT, env } from "../env.js";
import { ensureDir } from "../util.js";

/** 在 PATH 里找 pi（Windows 下可能是 pi.cmd / pi.exe） */
function resolvePi() {
  const configured = env("PI_BIN");
  if (configured) return { bin: configured, found: true };
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, "pi" + ext);
      try {
        if (fs.existsSync(p)) return { bin: p, found: true };
      } catch {}
    }
  }
  return { bin: "pi", found: false };
}

const { bin: PI_BIN, found: PI_FOUND } = resolvePi();
const OUTBOX = path.join(ROOT, "data", "outbox");
const SESSION_DIR = path.join(ROOT, "data", "agent-sessions");

export function agentAvailable() {
  return PI_FOUND;
}

/** 去掉 ANSI 颜色码，微信里不认 */
function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function systemPrompt() {
  const f = path.join(ROOT, "config", "agent-prompt.md");
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "你是公众号写作代理，工作目录就是你当前所在的目录。";
  }
}

/**
 * 跑一次 agent。
 * @param {object} o
 * @param {string} o.text    用户原话
 * @param {string} o.userid  用于 session 隔离
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ok:boolean, output:string, code:number, ms:number, timedOut:boolean}>}
 */
export function runAgent({ text, userid, busy = { running: false }, timeoutMs = 30 * 60_000 } = {}) {
  ensureDir(SESSION_DIR);

  const model = env("PI_MODEL", "opencode-go/deepseek-v4.1-flash");
  const thinking = env("PI_THINKING", "auto").trim();

  // 把“当前有没有任务在跑”当上下文告诉 agent，否则它会莫名其妙地看到个半成品项目
  // 注意：必须在 args 之前定义，否则会报 TDZ（Cannot access 'context' before initialization）
  const context = busy?.running
    ? `【当前状态】后台有一个写作任务在跑（选题「${busy.topic ?? "?"}」，已进行 ${busy.minutes ?? "?"} 分钟）。\n` +
      `它是独立子进程，你不需要等它跑完才开始回复。\n` +
      `但如果用户的要求依赖它的产物（比如基于这篇刚写的文章做封面、改标题），\n` +
      `你需要先轮询 data/bot-state.json，直到 phase 变成 idle，再去做那件事。\n` +
      `轮询命令示例： while grep -q '"phase": "generating"' data/bot-state.json; do sleep 20; done\n\n`
    : "";

  const args = [
    "--model",
    model,
    // pi 没有“auto”这个档位（只有 off/minimal/low/medium/high/xhigh/max）。
    // 填 auto 就**不传 --thinking**，让它用 ~/.pi/agent/settings.json 里的
    // defaultThinkingLevel，也就是“不钉死档位”的行为。
    ...(thinking && thinking !== "auto" ? ["--thinking", thinking] : []),
    // 只给必要的工具：能跑命令、能读写文件就够了
    "--tools",
    "bash,read,write,edit,ls,grep,find",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-context-files",
    "--session-dir",
    SESSION_DIR,
    "--session-id",
    `wecom-${userid}`,
    "--append-system-prompt",
    systemPrompt(),
    "--print",
    context + text,
  ];

  const started = Date.now();
  let out = "";
  let err = "";
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn(PI_BIN, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        // pi 通过 $OPENCODE_API_KEY 取凭证（见 ~/.pi/agent/models.json）
        OPENCODE_API_KEY: env("OPENCODE_API_KEY"),
        TZ: env("WX_TZ", "Asia/Shanghai"),
        PATH: [path.dirname(PI_BIN), process.env.PATH].filter(Boolean).join(path.delimiter),
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `启动 agent 失败：${e.message}`, code: -1, ms: Date.now() - started, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      let output = stripAnsi(out).trim();
      if (!output && err.trim()) output = stripAnsi(err).trim();
      if (timedOut) {
        output = output
          ? `${output}\n\n（已超时 ${Math.round(timeoutMs / 60000)} 分钟，被中断）`
          : `超时 ${Math.round(timeoutMs / 60000)} 分钟，已中断。`;
      }
      resolve({ ok: !timedOut && code === 0, output, code, ms, timedOut });
    });
  });
}

/* --------------------------- outbox：发图给用户 --------------------------- */

/**
 * agent 想让用户看到图片，就把文件放进 data/outbox/。
 * 这里把它们取出来、发出去、然后删掉。
 * @returns {Promise<{sent:number, files:string[]}>}
 */
export async function drainOutbox({ sendImage, max = 4 } = {}) {
  ensureDir(OUTBOX);
  const files = fs
    .readdirSync(OUTBOX)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .slice(0, max)
    .map((f) => path.join(OUTBOX, f));

  const sent = [];
  for (const f of files) {
    try {
      await sendImage(f);
      sent.push(f);
    } catch (err) {
      console.error(`[agent] 发图失败 ${path.basename(f)}：${err.message}`);
    } finally {
      // 无论成败都删掉，避免下次重复发
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
  return { sent: sent.length, files: sent.map((f) => path.basename(f)) };
}
