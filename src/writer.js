/**
 * 写作：两步走（大纲 -> 正文），再可选一轮自检。
 * 分两次调用而不是一次，是因为"先定结构再落笔"的文章明显比一次性生成的好读。
 */

import { chat, chatJson, modelFor } from "./llm.js";
import { countHan } from "./util.js";

/** 把论文原文块拼进 prompt（用户发 PDF 的文献解读模式） */
function paperBlock(source) {
  return `
【本次要解读的论文原文（节选，唯一可信来源）】
${source}

【文献解读的事实纪律】
- 全文观点必须以这篇论文为依据，不得引入其他文献的具体数据。
- 任何具体数字、方法名、结论都要能在原文找到；原文没写的，一律不得编造。
- 可以把论文的学术语言转成现场工程师能听懂的语言，但不能改变它的结论。
- 如果原文没有交代局限，就写「这篇没提」，不要替作者补。
`;
}

function banList(site) {  const items = site.style?.ban ?? [];
  return items.map((b) => `- ${b}`).join("\n");
}
function mustList(site) {
  const items = site.style?.must ?? [];
  return items.map((b) => `- ${b}`).join("\n");
}

/* --------------------------- 第一步：大纲 + 元信息 --------------------------- */

export async function planArticle({ site, picked, brief = "", source = "", history = [], log }) {
  const minW = site.article?.min_words ?? 1800;
  const maxW = site.article?.max_words ?? 2600;

  const prompt = `你是这个公众号的主笔，现在要为下面这个选题做写作大纲。

【选题】${picked.topic}
【切入角度】${picked.angle || "（由你决定）"}
${picked.why ? `【为什么值得写】${picked.why}` : ""}
${brief ? `\n【作者本次的额外要求（优先级高于你自己发挥）】\n${brief}\n` : ""}
${source ? paperBlock(source) : ""}

【写作人设】
${site.style?.persona ?? ""}

【读者】
${site.style?.audience ?? ""}

【语气】
${site.style?.tone ?? ""}

【历史上写过的标题，标题不要撞车】
${history.map((h) => `- ${h.title}`).join("\n") || "（无）"}

【硬要求】
${mustList(site)}

【禁止出现的表达】
${banList(site)}

【事实纪律】
- 你只能在确定的情况下给出具体数字、年份、人名、机构名、论文标题。
- 不确定就写"量级上大约""据公开报道"或直接不给数字，宁缺毋滥。
- 严禁编造论文、期刊、DOI、作者、具体百分比。

请设计一篇 ${minW}-${maxW} 字中文文章的骨架。${source ? "\n这是文献解读稿，结构按：①它想解决的真问题 ②方法上关键的那一步 ③结果到底说明了什么 ④哪里靠不住、局限在哪 ⑤对读者自己的工作有什么用。不要写成摘要翻译。" : ""}
要求：
1. 开头用一个具体场景或一个反直觉的事实切入，不要背景铺垫。
2. 中间 3 个左右的小标题，每个小标题下有一个可检验的判断，不是并列的泛泛而谈。
3. 必须有一节讨论这个判断的边界/反例/代价。
4. 结尾给一句可执行的结论，不要总结全文。

只输出 JSON：
{
  "title": "公众号标题，14-26字，具体、有信息量、不夸张不用感叹号",
  "cover_title": "封面图上用的短标题，8-16字，可以比正标题更锋利",
  "digest": "摘要，30-45字，会显示在分享卡片上，不超过 45 字",
  "outline": [
    {"h": "小标题（12字内）", "points": ["这一节要讲清楚的点1", "点2"], "evidence": "这一节依赖哪些事实/数据，以及你是否确定"}
  ],
  "opening": "开头第一段的大意（40字内）",
  "closing": "结尾那句可执行的结论（50字内）"
}`;

  const plan = await chatJson({
    model: modelFor(),
    temperature: 0.8,
    maxTokens: 9000,
    tag: "plan",
    messages: [{ role: "user", content: prompt }],
  });

  if (!plan?.title || !Array.isArray(plan.outline) || plan.outline.length === 0) {
    throw new Error(`大纲结构不完整：${JSON.stringify(plan).slice(0, 300)}`);
  }

  // 给每节分配字数预算：模型拿到具体数字比拿到一个区间写得长得多
  const targetTotal = Math.round(((minW + maxW) / 2));
  const sections = plan.outline.length;
  const base = Math.floor(targetTotal / sections / 20) * 20;
  plan.outline.forEach((sec, i) => {
    if (!Number.isFinite(sec.words) || sec.words < 200) {
      // 首节留点余量，末节收得紧一些
      sec.words = i === 0 ? base + 80 : i === sections - 1 ? base - 40 : base;
    }
  });
  plan.target_words = plan.outline.reduce((a, s) => a + s.words, 0);

  log?.info(`大纲就绪：《${plan.title}》 ${sections} 节，目标 ${plan.target_words} 字`);
  return plan;
}

/* ------------------------------ 第二步：正文 ------------------------------ */

export async function writeArticle({ site, picked, plan, brief = "", source = "", log }) {
  const minW = site.article?.min_words ?? 1800;
  const maxW = site.article?.max_words ?? 2600;

  const outlineText = plan.outline
    .map(
      (sec, i) =>
        `${i + 1}. ${sec.h}（本节不少于 ${sec.words ?? 500} 字）\n${(sec.points ?? [])
          .map((p) => `   - ${p}`)
          .join("\n")}${sec.evidence ? `\n   （依据：${sec.evidence}）` : ""}`
    )
    .join("\n");

  const targetTotal = plan.target_words ?? Math.round(((minW + maxW) / 2));

  const prompt = `按下面的大纲，写完整的文章正文。

标题：${plan.title}
选题：${picked.topic}
开头大意：${plan.opening ?? ""}
结尾结论：${plan.closing ?? ""}
${brief ? `\n【作者本次的额外要求（必须遵守）】\n${brief}\n` : ""}
${source ? paperBlock(source) : ""}

大纲：
${outlineText}

【写作人设】${site.style?.persona ?? ""}
【读者】${site.style?.audience ?? ""}
【语气】${site.style?.tone ?? ""}

【硬要求】
${mustList(site)}
- 全文不少于 ${minW} 个汉字，目标 ${targetTotal} 字，低于 ${minW} 字算不合格
- 每个小节必须写满它分到的字数，达不到说明展开不够：展开 = 补机制推演、反例、具体数字、操作步骤，不是凑墢亮话
- 段落 3-5 行，不要把一句话单独成段；同一个意思不要拆成多个小段
- 用 ==关键句== 标出 3-5 处最重要的判断（这是中文公众号的惯例，渲染后会变成彩色）
- 用 Markdown：小节用 "## "，不要在正文里重复写标题，不要出现一级标题 "# "
- 可以使用列表和引用块，但不要超过全文 25%
- 不要写"参考资料""延伸阅读"这类结尾模块

【禁止出现的表达】
${banList(site)}

【事实纪律（重要）】
- 只在确定时给出具体数字/年份/机构/论文。不确定就用"大致""量级上""据公开报道"。
- 严禁编造论文标题、作者、期刊、DOI、精确百分比。
- 如果某个论点需要数据但你并不确定，就明确写成"这个数我没有可靠来源，但从机制上应该是……"。

【风格要求】
- 不要每段都总结。不要用"这意味着"开头超过两次。
- 允许出现第一人称判断，例如"如果是我，我会先量一下再决定"。
- 至少有一处是别人可能会不同意的观点，并且你要正面回应可能的反驳。

直接输出正文 Markdown，不要任何前言、说明或代码围栏。`;

  const { content } = await chat({
    model: modelFor(),
    temperature: 0.85,
    maxTokens: 16000,
    timeoutMs: 420_000,
    tag: "write",
    messages: [{ role: "user", content: prompt }],
  });

  const md = stripFence(content).trim();
  const words = countHan(md);
  log?.info(`正文完成：${words} 字`);
  if (words < minW * 0.7) {
    log?.warn(`正文偏短（${words} 字 < 目标 ${minW}），继续流程但建议人工检查`);
  }
  return { markdown: md, words };
}

/* ------------------------------ 第三步：自检 ------------------------------ */

export async function reviewArticle({ site, plan, markdown, log }) {
  const before = countHan(markdown);
  const prompt = `下面是一篇准备发公众号的文章。请**只做必要的修改**，然后原样返回修改后的全文 Markdown。

修改目标（按优先级）：
1. 删掉 AI 味：模板化过渡句、"首先/其次/最后"、空泛排比、形容词堆砌、每段都总结。
2. 收紧冗余：同一个意思说两遍的删掉一处；能删的字就删。
3. 事实性表述降级：任何看起来像精确数据但缺乏来源的，改成"量级上大约""据公开报道"或删掉具体数字。**不要新增任何数字或引用。**
4. 段落长度：超过 5 行的段落拆开。
5. 保留作者的观点和语气，不要改成中性官腔。

篇幅约束：现在 ${before} 字，改完不得少于 ${Math.round(before * 0.92)} 字。删的是废话，不是内容。

不能做的事：
- 不要新增小节、不要改变文章的核心判断
- 不要添加"参考资料"模块
- 不要输出任何解释、前言、diff 说明

禁止出现的表达：
${banList(site)}

标题（仅供参考，不要改动）：${plan.title}

--- 文章开始 ---
${markdown}
--- 文章结束 ---`;

  const { content } = await chat({
    model: modelFor(site.article?.review_model),
    temperature: 0.4,
    maxTokens: 16000,
    timeoutMs: 420_000,
    tag: "review",
    messages: [{ role: "user", content: prompt }],
  });

  const revised = stripFence(content).trim();
  // 自检万一模型跑偏（返回空/返回说明文字），就退回原稿
  if (revised.length < markdown.length * 0.5) {
    log?.warn("自检返回内容异常偏短，放弃修改，保留原稿");
    return { markdown, words: countHan(markdown), reviewed: false };
  }
  const words = countHan(revised);
  log?.info(`自检完成：${words} 字`);
  return { markdown: revised, words, reviewed: true };
}

function stripFence(s) {
  const m = String(s).match(/^\s*```(?:markdown|md)?\s*([\s\S]*?)```\s*$/i);
  return m ? m[1] : s;
}

/* ------------------------- 第四步：不够长就补写 ------------------------- */

/**
 * 模型经常只写到目标字数的 70%，一次“针对局部补写”比重新整篇生成便宜得多。
 */
export async function expandArticle({ site, plan, markdown, log }) {
  const before = countHan(markdown);
  const target = plan.target_words ?? site.article?.min_words ?? 1800;
  if (before >= target * 0.9) return { markdown, words: before, expanded: false };

  const prompt = `下面这篇文章只有 ${before} 字，离目标 ${target} 字还差不少。请把它扩写。

硬性约束：
- 不新增小节，保持原有的小标题和顺序
- 不重复已经说过的意思，不许把一句话换个说法说两遍
- 不新增具体数字、百分比、论文、人名（编造事实是最严重的错误）
- 扩充只能靠这四种东西：更具体的机制推演、具体的反例/失败场景、可操作的检查步骤、对反驳意见的正面回应
- 扩写后不少于 ${Math.round(target * 0.9)} 字

【禁止出现的表达】
${banList(site)}

【原文】
${markdown}

直接输出扩写后的完整正文 Markdown，不要任何说明。`;

  const { content } = await chat({
    model: modelFor(),
    temperature: 0.85,
    maxTokens: 16000,
    timeoutMs: 420_000,
    tag: "expand",
    messages: [{ role: "user", content: prompt }],
  });

  const revised = stripFence(content).trim();
  const words = countHan(revised);
  if (words <= before * 1.05) {
    log?.warn(`补写无效（${before} -> ${words} 字），保留原稿`);
    return { markdown, words: before, expanded: false };
  }
  log?.info(`补写完成：${before} -> ${words} 字`);
  return { markdown: revised, words, expanded: true };
}
