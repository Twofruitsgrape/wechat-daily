/**
 * 机器人状态机（存 data/bot-state.json）
 *
 * 阶段：
 *   idle            空闲
 *   awaiting_topic  已发出「今天写什么」，等你回话
 *   generating      正在跑写作流水线
 */

import path from "node:path";
import { ROOT } from "../env.js";
import { readJson, writeJsonAtomic, nowIso } from "../util.js";

const FILE = path.join(ROOT, "data", "bot-state.json");

const EMPTY = {
  phase: "idle",
  date: null,
  topic: null,
  brief: null,
  startedAt: null,
  finishedAt: null,
  lastSummary: null,
  processedMsgIds: [],
};

export function loadBotState() {
  const s = readJson(FILE, null) ?? structuredClone(EMPTY);
  s.processedMsgIds ??= [];
  return s;
}

export function saveBotState(state) {
  // 只留最近 100 条已处理消息 ID，用于回调重试时去重
  if (state.processedMsgIds.length > 100) {
    state.processedMsgIds = state.processedMsgIds.slice(-100);
  }
  writeJsonAtomic(FILE, state);
}

export function setPhase(phase, patch = {}) {
  const s = loadBotState();
  s.phase = phase;
  Object.assign(s, patch, { updatedAt: nowIso() });
  saveBotState(s);
  return s;
}

/** 回调可能重试同一条消息，用 MsgId 去重 */
export function isDuplicateMsg(msgId) {
  if (!msgId) return false;
  const s = loadBotState();
  if (s.processedMsgIds.includes(msgId)) return true;
  s.processedMsgIds.push(msgId);
  saveBotState(s);
  return false;
}
