/**
 * 指令分发：收到用户文本之后干什么。
 *
 * 和传输层解耦：不关心消息从哪来（智能机器人长连接 / 将来的别的通道），
 * 只要给一个 send() 函数就能工作。
 */

import { loadBotState, setPhase, isDuplicateMsg } from "./state.js";
import { startPipeline, pipelineRunning } from "./runner.js";
import { runAgent, agentAvailable, drainOutbox } from "./agent.js";
import { sendImage, sendProactive } from "./channel.js";
import { env } from "../env.js";

const HELP = `**写作代理** · 你可以直接说人话

比如：
· 写一篇关于余热回收估算错误的，要手算例子
· 再做两个封面给我挑
· 刚才那篇第三段太啰嗦，压一压
· 把今天的稿子重新推一次草稿箱

**指令**
· \`状态\` — 现在在干什么
· \`取消\` — 放弃当前任务
· \`帮助\` — 这段说明`;

/** 只允许配置里的用户操作 */
export function isAllowed(userid) {
  const list = env("WECOM_ALLOWED_USERS")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (!list.length) return true; // 未配置则放行（首次引导用）
  return list.includes(userid);
}

/**
 * @param {object} o
 * @param {string} o.text    用户文本
 * @param {string} o.userid  发送者
 * @param {string} o.msgId   去重用
 * @param {(s:string)=>Promise<any>} o.send 回复函数
 */
export async function handleUserText({ text, userid, msgId, send }) {
  if (!isAllowed(userid)) {
    console.log(`[dispatch] 拒绝非授权用户 ${userid}`);
    return;
  }
  if (isDuplicateMsg(msgId)) {
    console.log(`[dispatch] 重复消息 ${msgId}`);
    return;
  }

  const input = String(text ?? "").trim();
  if (!input) return;
  console.log(`[dispatch] ${userid}: ${input.slice(0, 80)}`);

  const state = loadBotState();

  /* ---- 控制指令 ---- */
  if (/^(帮助|help|\?|？)$/i.test(input)) return send(HELP);

  if (/^(状态|status)$/i.test(input)) {
    if (state.phase === "generating") {
      const mins = state.startedAt ? Math.round((Date.now() - Date.parse(state.startedAt)) / 60000) : "?";
      return send(`**正在写**：${state.topic}\n\n已进行 ${mins} 分钟，写完叫你。`);
    }
    if (state.lastSummary) return send(`上一次的结果：\n\n${state.lastSummary}`);
    return send("现在空闲。发一段话给我，我就开始写。");
  }

  if (/^(取消|cancel)$/i.test(input)) {
    setPhase("idle");
    return send("已取消。下次要写直接发选题给我。");
  }

  // 不再因为“有任务在跑”就把消息拦掉：号主很可能就是想补充要求。
  // 把当前状态当作上下文交给 agent，由它自己决定是排队、等待还是先做别的。
  const busyState = pipelineRunning()
    ? {
        running: true,
        topic: state.topic,
        minutes: state.startedAt ? Math.round((Date.now() - Date.parse(state.startedAt)) / 60000) : null,
      }
    : { running: false };

  const redo = input.match(/^(重写|重做|redo)\s*([\s\S]*)$/i);
  if (redo) {
    const topic = state.topic || "";
    if (!topic) return send("还没有可重写的选题，先发一个给我。");
    const extra = (redo[2] ?? "").trim();
    const brief = [state.brief, extra].filter(Boolean).join("\n");
    await send(`收到，按「${topic}」再来一版${extra ? `，额外要求：${extra}` : ""}。约 6-8 分钟。`);
    startPipeline({ topic, brief, force: true, paper: /文献|论文|图文并茂/.test(brief + topic) });
    return;
  }

  /* ---- 剩下的一律交给 agent ---- */
  // 为什么不再写一堆匹配规则：号主会说「做两个适合的封面」「第三段再紧凑点」
  // 这种句子没法用正则穷举，交给会自己调工具的 agent 才靠谐。
  if (agentAvailable()) {
    console.log(`[dispatch] 交给 agent：${input.slice(0, 60)}${busyState.running ? "（流水线运行中）" : ""}`);
    // 有任务在跑就不发被动回复了（避免和完成通知撞车），直接交给 agent 处理完再回。
    if (busyState.running) {
      await send("收到。现在有一篇在写，我把你的要求记下来了。").catch(() => {});
    } else {
      await send("收到，我想一下怎么做，做完回你。");
    }

    let r;
    try {
      r = await runAgent({ text: input, userid, busy: busyState });
    } catch (err) {
      // agent 自己崩了（代码 bug 之类）也要说人话，别把 JS 报错直接甲给号主
      console.error(`[dispatch] agent 抛异常：${err.stack || err.message}`);
      r = {
        ok: false,
        output: `我这边执行时出了个错（${err.message}）。已经记进日志了，你可以再试一次，或者换个说法让我换条路。`,
        code: -1,
        timedOut: false,
        ms: 0,
      };
    }
    console.log(`[dispatch] agent 完成 code=${r.code} ${Math.round(r.ms / 1000)}s`);

    // agent 想给用户看的图（比如几个封面方案）会放在 data/outbox/
    try {
      const drained = await drainOutbox({ sendImage });
      if (drained.sent) console.log(`[dispatch] 已发出 ${drained.sent} 张图`);
    } catch (err) {
      console.error(`[dispatch] outbox 发送失败：${err.message}`);
    }

    const body = (r.output || "（agent 没有返回内容）").slice(0, 3000);
    const head = r.ok ? "" : r.timedOut ? "⚠️ 超时中断\n\n" : `⚠️ 执行异常（code=${r.code}）\n\n`;
    await sendProactive(head + body).catch((e) => console.error(`[dispatch] 结果推送失败：${e.message}`));
    return;
  }

  /* ---- 没有 agent 时的退化路径：当成纯选题交给流水线 ---- */
  const [topicPart, briefPart] = splitTopicBrief(input);
  // 提到“文献/论文/图文并茂”就自动开文献配图
  const wantsPaper = /文献|论文|paper|arxiv|图文并茂|配图|插图/i.test(input);
  await send(`收到，开始写：\n\n**${topicPart.slice(0, 120)}**\n\n约 6-8 分钟，写完进草稿箱后我立刻叫你。`);
  startPipeline({ topic: topicPart.slice(0, 120), brief: briefPart, force: true, paper: wantsPaper });
}

function splitTopicBrief(text) {
  const m = text.match(/^([^|｜\n]{2,120})\s*[|｜]\s*([\s\S]+)$/);
  if (m) return [m[1].trim(), m[2].trim()];
  return [text.trim(), text.trim()];
}
