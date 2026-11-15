// ============================================================
// 屏蔽词过滤：用户昵称 / AI 名称 / 自定义屏蔽词不参与检索
//
// 名字在记忆里到处都是（summary/gist 渲染 [user]/[ai] 后就是名字，
// 提取关键词也可能把人名抽进来），输入里一提名字就会把一堆无关记忆误命中。
// 名字对检索没有区分度——它标识「谁」而不是「什么事」，所以两边都剔：
// 写入侧关键词清洗 + 检索侧输入分词。自定义屏蔽词（「检索屏蔽词」设置）
// 同理用于过滤高频词，但**仅作用于检索召回**，记忆内容本身不打码、不修改。
//
// 依赖方向：只依赖 db/queries 与 settingsStore，
// 不要从 queries/tokenize 反向 import 本模块（会成环）。
// ============================================================

import { getUserInfo } from "@/db/queries";
import { useSettingsStore } from "@/store/settingsStore";
import { ensureTimePlaceholder } from "@/utils/text";

/** 参与过滤的身份名：用户昵称 + AI 名称（长度 ≥2 才有 bigram，才需要过滤） */
export function identityNames(): string[] {
  const nickname =
    getUserInfo()?.basic_identity?.nickname?.trim() ||
    useSettingsStore.getState().user_nickname.trim();
  const aiName = useSettingsStore.getState().ai_name.trim() || "私藏";
  return [...new Set([nickname, aiName])].filter((n) => n.length >= 2);
}

/**
 * 检索屏蔽词：「检索屏蔽词」设置里配置的词；未配置时默认 = 身份名。
 * 仅用于检索侧输入分词，记忆内容本身不做任何改写。
 */
export function blockedWords(): string[] {
  const raw = useSettingsStore.getState().blocked_keywords.trim();
  if (!raw) return identityNames();
  return [
    ...new Set(
      raw
        .split(/[,，、;；\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2) // 单字无区分度，且按包含关系会误杀一大片
    ),
  ];
}

/**
 * 该词是否只是屏蔽词的碎片（大小写不敏感）：
 * - 屏蔽词的 bigram（「小明」→「小明」）：word.includes(gram)
 * - 含屏蔽词的短语（「小明明」「小明的妈妈」）：gram.includes(word)
 */
export function isBlockedGram(gram: string, words: string[]): boolean {
  const g = gram.toLowerCase();
  return words.some((w) => {
    const word = w.toLowerCase();
    return word.includes(g) || g.includes(word);
  });
}

/** 写入侧关键词清洗：剔掉身份词（每条记忆都有名字，命中没有区分度） */
export function stripIdentityKeywords(keywords: string[]): string[] {
  const names = identityNames();
  return keywords.filter((k) => !isBlockedGram(k, names));
}

/**
 * 写入侧：把正文里的真实称呼换回 `[user]` / `[ai]` 占位符
 *
 * 模型偶尔直接写「静静」「哥哥」而不是占位符。名字写死进正文，后果是改名后记忆里的
 * 说法不跟着变，而且判定清单整份换一次字样、前缀缓存全废。只换长度 ≥2 的名字。
 */
export function restoreIdentityNames(text: string): string {
  if (!text) return text;
  const info = getUserInfo();
  const nickname =
    info?.basic_identity?.nickname?.trim() ||
    useSettingsStore.getState().user_nickname.trim();
  const aiName = useSettingsStore.getState().ai_name.trim() || "私藏";
  let out = text;
  if (aiName.length >= 2) out = out.split(aiName).join("[ai]");
  if (nickname.length >= 2 && nickname !== aiName) out = out.split(nickname).join("[user]");
  return out;
}

/** 写入侧统一入口：先补 `[time]`，再把真实称呼换回占位符 */
export function normalizeMemoryText(text: string): string {
  return restoreIdentityNames(ensureTimePlaceholder(text));
}
