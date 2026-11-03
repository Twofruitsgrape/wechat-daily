import crypto from "node:crypto";
import { env } from "./env.js";
import { sleep } from "./util.js";

const BASE = () => env("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1").replace(/\/+$/, "");
const KEY = () => env("OPENCODE_API_KEY");
const MODEL = () => env("OPENCODE_MODEL", "deepseek-v4.1-flash");
const MODEL_FAST = () => env("OPENCODE_MODEL_FAST") || MODEL();

// OpenCode Go 需要 x-opencode-session 头做路由，同一进程内固定一个即可
const SESSION_ID = crypto.randomUUID();

export const usage = { calls: 0, promptTokens: 0, completionTokens: 0, cost: 0 };

export function modelFor(alias) {
  return alias === "fast" ? MODEL_FAST() : MODEL();
}

/**
 * OpenAI 兼容的 chat/completions 调用。
 * 自带重试（网络错误 / 429 / 5xx），并把 usage 累计进 usage 对象。
 */
export async function chat({
  messages,
  model,
  temperature = 0.7,
  maxTokens = 8000,
  timeoutMs = 300_000,
  retries = 3,
  tag = "llm",
} = {}) {
  if (!KEY()) throw new Error("缺少 OPENCODE_API_KEY，无法调用模型");
  const useModel = model || MODEL();
  let lastErr;
  let budget = maxTokens;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE()}/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: (() => {
          const h = {
            Authorization: `Bearer ${KEY()}`,
            "Content-Type": "application/json",
          };
          // OpenCode Go 需要这个头做路由；别家不认识这个头，不要无脑带
          try {
            if (/(^|\.)opencode\.ai$/i.test(new URL(BASE()).hostname)) h["x-opencode-session"] = SESSION_ID;
          } catch {}
          return h;
        })(),
        body: JSON.stringify({
          model: useModel,
          messages,
          temperature,
          max_tokens: budget,
          stream: false,
        }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const e = new Error(`模型返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
        // 401/403 常被网关换成 HTML；这类错误重试没有意义
        if (res.status >= 400 && res.status < 500 && res.status !== 429) e.fatal = true;
        throw e;
      }

      if (!res.ok || data.type === "error" || data.error) {
        const msg = data?.error?.message || data?.error || text.slice(0, 300);
        const transient = res.status === 429 || res.status >= 500;
        if (transient && attempt < retries) {
          const wait = 3000 * attempt;
          console.error(`[${tag}] 第 ${attempt} 次失败（${res.status}），${wait}ms 后重试：${msg}`);
          await sleep(wait);
          lastErr = new Error(msg);
          continue;
        }
        const e = new Error(`模型调用失败（HTTP ${res.status}）：${msg}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) e.fatal = true;
        throw e;
      }

      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? "";

      // deepseek 这类推理模型会把 max_tokens 花在 reasoning 上，正文一个字不剩。
      // 遇到这种情况直接把预算翻倍重试，而不是当成失败。
      if (!content.trim() && choice?.finish_reason === "length" && attempt < retries) {
        console.error(`[${tag}] 输出被截断（推理占用了全部 ${budget} tokens），预算翻倍重试`);
        budget *= 2;
        continue;
      }
      if (!content.trim()) {
        throw new Error(`模型返回空内容（finish_reason=${choice?.finish_reason}，max_tokens=${budget}）`);
      }
      if (choice.finish_reason === "length") {
        console.error(`[${tag}] 警告：输出被 max_tokens=${budget} 截断`);
      }

      const u = data.usage ?? {};
      usage.calls += 1;
      usage.promptTokens += u.prompt_tokens ?? 0;
      usage.completionTokens += u.completion_tokens ?? 0;
      usage.cost += u.cost ?? 0;
      console.error(
        `[${tag}] ${useModel} ok  in=${u.prompt_tokens ?? "?"} out=${u.completion_tokens ?? "?"}`
      );

      return { content, finishReason: choice.finish_reason, usage: u, model: useModel };
    } catch (err) {
      lastErr = err;
      const isAbort = err.name === "AbortError";
      if (isAbort) throw new Error(`模型调用超时（${timeoutMs}ms，模型 ${useModel}）`);
      // 400/401/403/404 这类错误，重试只会浪费时间和额度
      if (err.fatal || attempt >= retries) break;
      const wait = 3000 * attempt;
      console.error(`[${tag}] 第 ${attempt} 次异常，${wait}ms 后重试：${err.message}`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("模型调用失败");
}

/**
 * 要求模型返回 JSON，并容错解析（去掉 ```json 围栏、截取第一个 { 到最后一个 }）。
 */
export async function chatJson(opts) {
  const { content } = await chat({ ...opts, temperature: opts.temperature ?? 0.4 });
  return parseJsonLoose(content);
}

export function parseJsonLoose(text) {
  let s = String(text).trim();
  // 去掉 markdown 代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试截取 */
  }
  const start = s.search(/[{[]/);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (e) {
      throw new Error(`模型返回的 JSON 无法解析：${e.message}\n原文前 500 字：\n${text.slice(0, 500)}`);
    }
  }
  throw new Error(`模型没有返回 JSON。原文前 500 字：\n${text.slice(0, 500)}`);
}
