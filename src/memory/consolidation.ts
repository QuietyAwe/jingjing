// ============================================================
// P5-3 / P5-4: 巩固流主模块
// 双重关联写入事务 + 30s 超时 + 计数归零
// ============================================================

import { getDB } from "@/db/connection";
import {
  getUserInfo,
  mergeUserInfo,
  insertEvent,
  insertFragment,
  getCandidateEvents,
  getMeta,
  setMeta,
  updateEventPriority,
  getDefaultEventId,
  getEventById,
  findSimilarEvent,
  getFragmentsByEventIds,
  mergeEvents,
  getEventByAlias,
  addEventAliases,
  upsertFutureEvent,
} from "@/db/queries";
import { extractConsolidation } from "@/llm/background";
import type { CandidateEvent } from "@/llm/background";
import { tokenize } from "./tokenize";
import { blockedWords, isBlockedGram } from "./identity";
import { anchorLine, estimateTokens } from "@/prompt/assembler";
import { getThresholds } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { useMetaStore } from "@/store/metaStore";
import type { UserInfo } from "@/types/schema";
import dayjs from "dayjs";

const LOCK_TIMEOUT_MS = 30_000; // 30s 超时

/**
 * 定位「上次巩固结束到哪条」——用消息 id 锚定，不能用数组下标
 *
 * 消息是会被删除的（长按删单条、整局删除游戏卡片、清除数据），
 * 删除会让后面的下标整体左移，用下标做游标就会永久跳过一截对话。
 *
 * 锚点本身被删掉时退化到时间戳兜底；彻底定位不到就当成「都巩固过了」，
 * 宁可少提取一次，也不要把老记忆重复提取一遍。
 */
function resolveCursor(
  messages: Array<{ id: string; timestamp: string }>
): number {
  const anchorId = getMeta("last_consolidated_id");
  if (anchorId) {
    const idx = messages.findIndex((m) => m.id === anchorId);
    if (idx >= 0) return idx + 1;
    const at = getMeta("last_consolidated_at");
    if (at) {
      const j = messages.findIndex((m) => m.timestamp > at);
      return j < 0 ? messages.length : j;
    }
    return messages.length;
  }

  // 旧版本用数组下标做游标：迁移成「那条之后」，老设备平滑过渡
  const legacy = parseInt(getMeta("last_consolidated_index") ?? "0", 10);
  const anchor = messages[legacy - 1];
  if (anchor) {
    setMeta("last_consolidated_id", anchor.id);
    setMeta("last_consolidated_at", anchor.timestamp);
    return legacy;
  }
  // 锚点定位不到（消息被删导致下标越界 / meta 损坏）：宁可少提取，
  // 也不能返回 0 从头重提——那会把全部历史重复提取一遍，产生重复记忆
  return legacy > 0 ? Math.min(legacy, messages.length) : 0;
}

/** 记下「巩固已经推进到这条」 */
function advanceCursor(messages: Array<{ id: string; timestamp: string }>, endExclusive: number): void {
  const anchor = messages[endExclusive - 1];
  if (!anchor) return;
  setMeta("last_consolidated_id", anchor.id);
  setMeta("last_consolidated_at", anchor.timestamp);
  // 保留下标副本：仅用于旧版本兼容与调试排查
  setMeta("last_consolidated_index", String(endExclusive));
}

/**
 * 末尾「还没定稿」的那一轮的起点：最后一条助手回复随时可能被「重新生成」替换，
 * 它配对的用户消息也可能被「编辑后重发」连带删掉。这一轮巩固进去，
 * 就会把用户实际没留下的版本写成记忆，所以只有它不再是末尾时才提取。
 *
 * 末尾是用户消息（还没回复 / 回复失败）时只预留它自己；
 * 找不到配对用户消息（开场白等）时只预留最后一条回复。
 */
function unsettledTailStart(messages: Array<{ role: string }>): number {
  const last = messages.length - 1;
  if (last < 0) return 0;
  if (messages[last].role !== "assistant") return last;
  for (let i = last - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return last;
}

/**
 * 一批最多吃多少对话：从 start 往后累加 token，够一批就停（至少 1 条）。
 *
 * 几天没打开时积压可能上百轮，一次全塞进去会让这次提取只来得及写 8 条片段、
 * 其余内容被丢掉；剩余积压由下一个触发点（回复完成 / 进前台 / 发消息）继续消化。
 */
function batchWindowEnd(
  messages: Array<{ content: string }>,
  start: number,
  end: number,
  tokenBudget: number
): number {
  let tokens = 0;
  for (let i = start; i < end; i++) {
    tokens += estimateTokens(messages[i].content);
    if (tokens >= tokenBudget) return i + 1;
  }
  return end;
}

/**
 * 未来事件的标题去掉开头的时间词：「下周三下午面试」→「面试」
 *
 * 标题会进状态区的「安排」和提醒文案，留着「下周三」在过期之后就是错误信息；
 * 剥完不足 2 个字的保持原样（如「搬家」本身没有时间词）。
 */
function stripLeadingTimeWords(text: string): string {
  const stripped = text
    .replace(/^(今天|明天|后天|大后天|这周|本周|下周|下下周|周[一二三四五六日天]|礼拜[一二三四五六日天])/, "")
    .replace(/^(上午|下午|晚上|中午|早上|凌晨)/, "")
    .trim();
  return stripped.length >= 2 ? stripped : text;
}

/** 触发判定需要的消息形状 */
type TriggerMessage = {
  id: string;
  timestamp: string;
  role: string;
  content: string;
  game_id?: number;
  friend_id?: number;
};

/**
 * 检查是否应触发巩固流
 *
 * 不再按 turn_counter 固定 10 轮切：攒够 token 预算（默认 10k）或距上次巩固超过
 * 空闲阈值（默认 30 分钟）才触发。少于最小窗口轮数不触发，避免聊两句就调一次 LLM。
 */
export function shouldConsolidate(
  messages: TriggerMessage[],
  opts?: { checkIdle?: boolean }
): boolean {
  if (getMeta("is_locked") === "true") return false;

  const {
    consolidation_window_turns,
    consolidation_token_budget,
    consolidation_idle_minutes,
  } = getThresholds();

  const cursor = resolveCursor(messages);
  // 末尾未定稿的一轮随时可能被重新生成/编辑重发，不算进触发依据
  const settledEnd = unsettledTailStart(messages);
  const pending = messages
    .slice(cursor, settledEnd)
    .filter((m) => !m.game_id && !m.friend_id);

  // 最小窗口：不足这么多条不看，防止碎片化调用
  if (pending.length < consolidation_window_turns * 2) return false;

  const tokens = pending.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (tokens >= consolidation_token_budget) {
    logDebug("巩固检查", `未巩固 ${tokens} token ≥ ${consolidation_token_budget}，触发巩固`);
    return true;
  }

  // 空闲触发：用户已经停了一段时间，把不满一个预算的积压也消化掉。
  // 只用「最后一条消息距现在多久」判断——last_consolidated_at 是批末消息时间，
  // 不是巩固执行时刻，拿它算空闲永远偏大。
  // 也只在「进前台 / 用户开口前」这类时机传 checkIdle：
  // 刚回复完时最后一条消息就是刚发的，空闲恒为 0，没有意义。
  if (opts?.checkIdle) {
    const lastTs = messages[messages.length - 1]?.timestamp;
    const idleMinutes = lastTs ? dayjs().diff(dayjs(lastTs), "minute") : 0;
    if (idleMinutes >= consolidation_idle_minutes) {
      logDebug("巩固检查", `已空闲 ${Math.round(idleMinutes)} 分钟 ≥ ${consolidation_idle_minutes}，触发巩固`);
      return true;
    }
  }

  logDebug("巩固检查", `未巩固 ${tokens} token，未达阈值`);
  return false;
}

/**
 * 执行巩固流：每次只消化一批（约一个 token 预算），积压靠下一个触发点继续消化
 * @param recentMessages 最近的对话消息（不含 system）
 * @returns 是否成功写入
 */
export async function runConsolidation(
  recentMessages: Array<{
    id: string;
    timestamp: string;
    role: string;
    content: string;
    game_id?: number;
    friend_id?: number;
  }>
): Promise<boolean> {
  const cursorBefore = resolveCursor(recentMessages);
  const pendingCount = Math.max(0, unsettledTailStart(recentMessages) - cursorBefore);
  logDebug("巩固开始", `消息数=${recentMessages.length}，游标位置=${cursorBefore}，待巩固 ${pendingCount} 条`);

  // 1. 获取锁（同步更新内存 + DB）
  useMetaStore.getState().setLocked(true);

  // 30s 超时兜底（只释放锁，不清零计数器，下次达到阈值时重试）
  const timeoutTimer = setTimeout(() => {
    logDebug("巩固超时", "30s 强制解锁, is_locked=false");
    useMetaStore.getState().setLocked(false);
  }, LOCK_TIMEOUT_MS);

  try {
    // 2. 读取当前 user_info
    let userInfo = getUserInfo();
    if (!userInfo) {
      // 空库首次：用空模板
      userInfo = {
        basic_identity: { nickname: "", gender: "", birthday: "", occupation: "", location: "" },
        social_graph: [],
        traits: [],
        states: [],
      };
    }

    // 3. 取「上次巩固结束之后」的消息
    // 游标按消息 id 锚定（见 resolveCursor），消息被删除不会让游标错位
    const { consolidation_token_budget } = getThresholds();
    // 末尾未定稿的一轮（可能被重新生成 / 编辑后重发）不提取，等它不再是末尾再说：
    // 只截这一轮，剩下从游标一路补到它之前——不能按窗口大小从尾部对齐（len-windowSize），
    // 那会让提取永远落后一轮，且游标一旦因分批消化 / 删消息滞后，
    // 预留窗会把刚聊的新对话整体圈走，退化成「只提取一两条陈年消息」
    // （2026-10-12 现场：287 条只提取到 1 条 03:41 的旧消息）
    const settledEnd = unsettledTailStart(recentMessages);
    const start = Math.min(resolveCursor(recentMessages), settledEnd);
    // 一批只吃一个 token 预算：积压长时分批，剩下的由下一个触发点续跑
    const windowStart = batchWindowEnd(
      recentMessages,
      start,
      settledEnd,
      consolidation_token_budget
    );
    const windowMessages = recentMessages.slice(start, windowStart);
    // 游戏回合由游戏自己的巩固写入记忆，这里跳过，避免重复记账。
    // 好友私聊同理：好友对话不进主 AI 记忆（信息隔离），只留一条弱痕迹。
    // 注意：被跳过的只是「不参与提取」，游标仍会推进——否则一整段对局会让巩固反复空转
    const snapshot = windowMessages.filter((m) => !m.game_id && !m.friend_id);
    // 批末消息时间 = 这批对话实际发生的时刻：提取提示词与落库时间戳都用它，
    // 避免把历史对话当成「现在」巩固（否则几天前的事被写成「今天」）
    const batchEndTs =
      windowMessages[windowMessages.length - 1]?.timestamp ?? dayjs().toISOString();
    logDebug(
      "巩固范围",
      `start=${start}, windowStart=${windowStart}, 窗口${windowMessages.length}条，剔除游戏回合后提取${snapshot.length}条，剩余${Math.max(0, settledEnd - windowStart)}条，批末时间=${dayjs(batchEndTs).format("MM-DD HH:mm")}`
    );

    // 没有可提取的新消息（只剩末尾未定稿的一轮 / 全是游戏好友回合），跳过提取
    if (snapshot.length === 0) {
      logDebug("巩固跳过", "无可提取消息（末尾一轮未定稿或全为游戏回合）");
      clearTimeout(timeoutTimer);
      useMetaStore.getState().setLocked(false);
      // 游标仍要推进：窗口里全是游戏回合时（游戏自己的巩固已经记账了）
      // 不推进会让同一段对局反复空转，卡住巩固进度
      if (windowMessages.length > 0) advanceCursor(recentMessages, windowStart);
      // 仍清零计数器，避免反复触发
      useMetaStore.getState().reset();
      return true;
    }

    // 4. 关键词倒排取候选事件：只给「这段对话可能在延续的」3~5 条，
    //    不再全量塞 20 个事件标题（目录是巩固请求里最大的重复成本）
    const candidateKeywords = tokenize(
      snapshot.map((m) => m.content).join("\n"),
      24,
      (g) => isBlockedGram(g, blockedWords())
    );
    const candidateEvents = getCandidateEvents(candidateKeywords, 5);
    // 4b. 每个候选给「最早 1 条 + 最近 2 条」片段：
    //     最早那条定义主题，最近两条说明「还在延续」——判断是否同一段经历最有效
    const candidateFragments = getFragmentsByEventIds(candidateEvents.map((e) => e.id));
    const candidates: CandidateEvent[] = candidateEvents.map((e) => {
      const frags = candidateFragments.get(e.id) ?? [];
      const picked = frags.length <= 3 ? frags : [frags[0], ...frags.slice(-2)];
      return {
        id: e.id,
        title: e.event_text,
        snippets: picked.map((f) => anchorLine(f.summary, f.timestamp, userInfo)),
      };
    });
    // 默认事件作为兜底候选：没有明确主题的零碎片段挂这里，别乱建事件
    const defaultEventId = getDefaultEventId();
    const defaultEvent = defaultEventId ? getEventById(defaultEventId) : null;
    if (defaultEvent) {
      candidates.push({
        id: defaultEvent.id,
        title: `${defaultEvent.event_text}（兜底：没有明确主题的零碎片段挂这里）`,
        snippets: [],
      });
    }

    // 5. 调用后台 LLM 提取（增量模式，传 userInfo 供展示已有数据）
    const result = await extractConsolidation(
      userInfo,
      snapshot,
      candidates,
      getMeta("session_digest") ?? undefined,
      LOCK_TIMEOUT_MS - 2000,
      batchEndTs
    );
    if (!result) {
      logDebug("巩固结果", "LLM 提取失败或返回空, is_locked=false, 保留计数器下次重试");
      clearTimeout(timeoutTimer);
      useMetaStore.getState().setLocked(false);
      return false;
    }

    // 6. 双重关联写入（SQLite 事务）
    const db = getDB();
    const written: string[] = [];
    /** 被合并掉的事件 id → keep id：本次返回的 target_event_index 可能指向已删除的行 */
    const idMap = new Map<number, number>();
    await db.withExclusiveTransactionAsync(async () => {
      // 6a. Merge user_info（增量模式，new_info 只含新发现的字段）
      // nickname 的真相源即此处的 user_info.basic_identity，无需额外写入 AsyncStorage。
      // 状态/事件的时间戳同样沿用批末消息时间，不记成巩固执行时刻
      mergeUserInfo(result.new_info, batchEndTs);

      // 6b. 先执行模型给出的归并决策，再写片段——
      // 片段可能指向一条刚刚被并掉的事件，必须按 idMap 重定向
      for (const m of result.event_merges ?? []) {
        if (!getEventById(m.keep)) continue;
        const validMergeIds = m.merge.filter((id) => !!getEventById(id));
        if (validMergeIds.length === 0) continue;
        mergeEvents(m.keep, validMergeIds);
        for (const id of validMergeIds) idMap.set(id, m.keep);
        written.push(
          `  ⋈ 合并事件 [${m.keep}] ← [${validMergeIds.join(", ")}]${m.reason ? `（${m.reason}）` : ""}`
        );
      }

      // 6c. 逐条写入片段（一次巩固可能覆盖多个话题）
      for (const frag of result.new_fragments ?? []) {
        const priority = frag.priority || 5;
        let targetEventId: number;
        let fragTs = batchEndTs;
        // 模型在同一份回复里既说「把 9 并进 7」又说「新片段挂 9」：按映射改投 7
        const mappedTarget = idMap.get(frag.target_event_index) ?? frag.target_event_index;

        if (frag.happens_at) {
          // 将来才发生的事（约定 / 离职 / 考试 / 手术…）：独立成一条未来事件，
          // 不挂到已发生的记忆上。事件 timestamp = 发生时刻，到点由时间通道提醒
          const rawTitle =
            frag.new_event_text?.trim() ||
            frag.gist.replace(/\[(?:user|ai|time)\]/g, "").trim().slice(0, 20) ||
            "待发生的事";
          targetEventId = upsertFutureEvent(stripLeadingTimeWords(rawTitle), frag.happens_at, priority);
          fragTs = frag.happens_at;
        } else if (mappedTarget > 0 && getEventById(mappedTarget)) {
          // LLM 指定了已有事件 ID（无效 ID 回落，避免写进悬空事件）
          targetEventId = mappedTarget;
        } else if (frag.new_event_text?.trim()) {
          const title = frag.new_event_text.trim();
          // 先查别名：合并过的标题/关键词直接挂靠，同一个判断不用模型再做一次；
          // 再退回 bigram 兜底，避免标题换个说法就新建事件
          const similar = getEventByAlias(title) ?? findSimilarEvent(title);
          if (similar) {
            targetEventId = similar.id;
            addEventAliases(similar.id, [title]);
          } else {
            targetEventId = insertEvent(title, 100, priority, "episode", batchEndTs);
          }
        } else {
          // 兜底：挂靠默认事件"日常闲聊"
          const defaultId = getDefaultEventId();
          if (defaultId) {
            targetEventId = defaultId;
          } else {
            targetEventId = insertEvent("日常闲聊", 50, 1, "daily", batchEndTs);
            // 记下元数据，否则下次兜底又会再建一个「日常闲聊」
            setMeta("default_event_id", String(targetEventId));
          }
        }

        insertFragment(targetEventId, frag.gist, frag.summary, priority, (frag.keywords ?? []).join(","), fragTs);
        updateEventPriority(targetEventId, priority);
        written.push(`  · [${targetEventId}] ${frag.gist}`);
      }
    });

    clearTimeout(timeoutTimer);

    // 7. 会话摘要：旧摘要 + 本批对话压成新摘要，供前台替代已巩固的对话。
    //    游标一旦推进，这段对话就只剩摘要能代表它——本次必须有摘要可写。
    //    模型漏写时用本批片段 gist 拼一段兜底，宁可粗糙也不能让覆盖范围断档。
    const prevDigest = getMeta("session_digest") ?? "";
    const nextDigest =
      result.session_digest?.trim() ||
      [prevDigest, ...(result.new_fragments ?? []).map((f) => f.gist)]
        .filter(Boolean)
        .join("；")
        .slice(-400);
    if (nextDigest) {
      setMeta("session_digest", nextDigest.slice(0, 400));
      setMeta("session_digest_at", batchEndTs);
    }

    // 8. 释放锁 + 清零计数 + 记录巩固进度（同步更新内存 + DB）
    advanceCursor(recentMessages, windowStart);
    useMetaStore.getState().reset();

    logDebug(
      "巩固完成",
      `候选 ${candidates.length} 个 / 归并 ${result.event_merges?.length ?? 0} 组 / 摘要 ${nextDigest.length} 字\n${written.join("\n")}\n进度: 已推进到第 ${windowStart} 条`
    );
    return true;
  } catch (err) {
    clearTimeout(timeoutTimer);
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("巩固异常", `${errMsg}\nis_locked=false, 保留计数器下次重试`);
    useMetaStore.getState().setLocked(false);
    return false;
  }
}


