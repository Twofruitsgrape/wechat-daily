import path from "node:path";
import { ROOT } from "./env.js";
import { readJson, writeJsonAtomic, nowIso } from "./util.js";

const STATE_FILE = path.join(ROOT, "data", "state.json");

const EMPTY = { token: null, runs: [], usedTopics: [] };

export function loadState() {
  const s = readJson(STATE_FILE, null) ?? structuredClone(EMPTY);
  s.runs ??= [];
  s.usedTopics ??= [];
  return s;
}

export function saveState(state) {
  // 只保留最近 200 条运行记录，别让文件无限长大
  if (state.runs.length > 200) state.runs = state.runs.slice(-200);
  if (state.usedTopics.length > 400) state.usedTopics = state.usedTopics.slice(-400);
  writeJsonAtomic(STATE_FILE, state);
}

export function getRun(state, date) {
  return state.runs.find((r) => r.date === date) ?? null;
}

export function upsertRun(state, date, patch) {
  let run = getRun(state, date);
  if (!run) {
    run = { date, at: nowIso(), status: "started" };
    state.runs.push(run);
  }
  Object.assign(run, patch, { updatedAt: nowIso() });
  return run;
}

/** 记录已用过的选题，下次选题时作为「别重复」的输入 */
export function rememberTopic(state, topic, title) {
  state.usedTopics.push({ topic, title, date: nowIso().slice(0, 10) });
}

export function recentTitles(state, n = 20) {
  return state.runs
    .filter((r) => r.title)
    .slice(-n)
    .map((r) => ({ date: r.date, title: r.title, topic: r.topic }));
}

/** access_token 缓存读写（微信 token 有效期 7200s，这里提前 5 分钟过期） */
export function cacheToken(state, accessToken, expiresInSec = 7200) {
  state.token = { accessToken, expiresAt: Date.now() + (expiresInSec - 300) * 1000 };
  saveState(state);
}

export function getCachedToken(state) {
  const t = state.token;
  if (!t?.accessToken) return null;
  if (!t.expiresAt || Date.now() > t.expiresAt) return null;
  return t.accessToken;
}
