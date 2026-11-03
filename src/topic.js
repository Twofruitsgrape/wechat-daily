/**
 * 选题：优先从话题池里取，池子空了就让模型在 domain 内自己挑。
 * 所有已用过的选题记在 state.usedTopics，保证不重复。
 */

import { readYaml } from "./util.js";
import { chatJson, modelFor } from "./llm.js";

export async function chooseTopic({ site, state, dateStr, log }) {
  const topicsCfg = site.topics_file ? readYaml(site.topics_file) : {};
  const pool = Array.isArray(topicsCfg.pool) ? topicsCfg.pool : [];
  const used = new Set(state.usedTopics.map((t) => normalize(t.topic)));

  // 1) 话题池还有没用过的，直接取
  const fresh = pool.filter((p) => !used.has(normalize(topicText(p))));
  if (fresh.length) {
    const picked = fresh[0];
    log?.info(`选题来自话题池：${topicText(picked)}`);
    return {
      topic: topicText(picked),
      angle: typeof picked === "object" ? picked.angle ?? "" : "",
      source: "pool",
      remaining: fresh.length - 1,
    };
  }

  // 2) 池子空 -> 让模型自选
  const recent = state.runs
    .filter((r) => r.title)
    .slice(-15)
    .map((r) => `- ${r.date}｜${r.title}（${r.topic ?? ""}）`)
    .join("\n");

  const domain = topicsCfg.domain || "科技与工程";
  const avoid = (topicsCfg.avoid ?? []).map((a) => `- ${a}`).join("\n");

  const prompt = `你是这个公众号的主笔。请为今天的文章选一个**具体的**选题。

【公众号方向】
${domain}

【读者】
${site.style?.audience ?? "有专业基础但没时间读原文的技术从业者"}

【最近已发表的标题（必须避开，不要写同题或近题）】
${recent || "（这是第一篇）"}

【明确不写的内容】
${avoid || "（无）"}

【选题要求】
1. 必须是一个能被一句话说清的具体问题，不要"XX的现状与未来"这种。
2. 要有一个明确的、可能引起争议或反直觉的判断空间，而不是教科书式的科普。
3. 适合 2000 字左右展开，能落到可操作的建议。
4. 不追热点新闻本身，追热点背后的机制或误判。

只输出 JSON，不要任何解释：
{"topic":"选题一句话（20字内）","angle":"你打算切入的角度和核心观点（60字内）","why_now":"为什么现在值得写（30字内）"}`;

  const picked = await chatJson({
    model: modelFor("fast"),
    temperature: 0.9,
    maxTokens: 3000,
    tag: "topic",
    messages: [{ role: "user", content: prompt }],
  });

  if (!picked?.topic) throw new Error("选题模型没有返回有效的 topic");
  log?.info(`选题由模型生成：${picked.topic}`);
  return {
    topic: String(picked.topic).trim(),
    angle: String(picked.angle ?? "").trim(),
    why: String(picked.why_now ?? "").trim(),
    source: "model",
    remaining: 0,
  };
}

function topicText(t) {
  return typeof t === "string" ? t : String(t?.topic ?? "");
}
function normalize(s) {
  return String(s ?? "").replace(/\s+/g, "").slice(0, 24);
}
