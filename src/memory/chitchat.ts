// ============================================================
// 覆盖检查：整句只有寒暄 / 语法成分 / 屏蔽词时，不调 AI 判定
// ============================================================

import { STOP_WORDS } from "./tokenize";

/**
 * 判定前归一化：去掉空白、标点、符号（含 emoji）
 *
 * 只做清理，不改写用词——覆盖检查的口径必须和检索一致，
 * 否则会出现「检索认为有意义、闸门认为没意义」。
 */
export function normalizeForGate(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** 表里最长词的长度：最长匹配的上界（加上额外的屏蔽词后按需放大） */
const MAX_STOP_LEN = Math.max(...Array.from(STOP_WORDS, (w) => w.length));

/**
 * 整句话是否只由覆盖词组成
 *
 * 从首字往后最长匹配，每个片段都必须被词表吃掉；遇到吃不掉的片段立刻判为「有实词」——
 * 宁可多调一次 AI，不能漏想一件事。词表 = 停用词 + 用户配置的「检索屏蔽词」
 * （屏蔽词按「不作为想起往事的依据」处理，所以只打一个称呼也算没有内容）。
 * 只有「嗯嗯」「哈哈」这类重复单字允许整体吃两个字符，前提是该单字本身在表里
 * （所以「妈妈」不会被当成重复而消掉）。
 */
export function isChitchatOnly(text: string, extraWords?: Iterable<string>): boolean {
  const s = normalizeForGate(text);
  if (!s) return true;

  let maxLen = MAX_STOP_LEN;
  const words = extraWords ? new Set(STOP_WORDS) : STOP_WORDS;
  if (extraWords) {
    for (const raw of extraWords) {
      const w = normalizeForGate(raw);
      if (w.length === 0) continue;
      words.add(w);
      if (w.length > maxLen) maxLen = w.length;
    }
  }

  let i = 0;
  while (i < s.length) {
    let consumed = 0;
    if (i + 1 < s.length && s[i] === s[i + 1] && words.has(s[i])) {
      consumed = 2;
    }
    for (let len = Math.min(maxLen, s.length - i); len >= 1 && consumed === 0; len--) {
      if (words.has(s.slice(i, i + len))) {
        consumed = len;
        break;
      }
    }
    if (consumed === 0) return false;
    i += consumed;
  }
  return true;
}
