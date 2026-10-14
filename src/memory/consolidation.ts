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
  getTopActive,
  getMeta,
  setMeta,
  updateEventPriority,
  getDefaultEventId,
  getEventById,
  findSimilarEvent,
  getFragmentsByEventIds,
} from "@/db/queries";
import { extractConsolidation } from "@/llm/background";
import { hasApiKey } from "@/llm/client";
import { getThresholds } from "@/prompt/config";
import { logDebug, useChatStore } from "@/store/chatStore";
import { useMetaStore } from "@/store/metaStore";
import type { UserInfo } from "@/types/schema";
import dayjs from "dayjs";

const LOCK_TIMEOUT_MS = 30_000; // 30s 超时
/** 启动补巩固：每次启动最多补的批数（每批约一个巩固窗口），剩余积压下次启动续跑 */
const CATCH_UP_MAX_BATCHES = 5;
/** 等 persist 水合的上限；超时就用当前内存里的消息（最多是少补一次，不会出错） */
const HYDRATE_WAIT_MS = 5_000;

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

/** 是否还有游标之后未巩固的消息 */
export function hasPendingConsolidation(
  messages: Array<{ id: string; timestamp: string }>
): boolean {
  return resolveCursor(messages) < messages.length;
}

/**
 * 等 chatStore persist 水合完成——消息异步从 AsyncStorage 恢复，
 * 早于水合拿到的是空数组，会把「有积压」误判成「无积压」
 */
function waitForMessagesHydration(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let unsub: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      unsub?.();
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, HYDRATE_WAIT_MS);
    if (useChatStore.persist.hasHydrated()) {
      done();
      return;
    }
    unsub = useChatStore.persist.onFinishHydration(done);
  });
}

/**
 * 检查是否应触发巩固流
 * 条件：turn_counter >= 阈值 且 is_locked == false 且 user_info 存在
 */
export function shouldConsolidate(): boolean {
  const locked = getMeta("is_locked");
  const counter = parseInt(getMeta("turn_counter") ?? "0", 10);
  const { consolidation_window_turns } = getThresholds();

  logDebug("巩固检查", `turn_counter=${counter}, threshold=${consolidation_window_turns}, is_locked=${locked}`);

  if (locked === "true") return false;
  return counter >= consolidation_window_turns;
}

/**
 * 执行巩固流
 * @param recentMessages 最近的对话消息（不含 system）
 * @param opts.catchUp 启动补巩固模式：积压可能很长，每批至多一个窗口、分批消化；
 *                    默认 false（常规）：一次补到消息末尾（就是本次计数器数出来的那几轮）
 * @returns 是否成功写入
 */
export async function runConsolidation(
  recentMessages: Array<{ id: string; timestamp: string; role: string; content: string; game_id?: number }>,
  opts?: { catchUp?: boolean },
): Promise<boolean> {
  const counterBefore = parseInt(getMeta("turn_counter") ?? "0", 10);
  logDebug("巩固开始", `turn_counter=${counterBefore}, 消息数=${recentMessages.length}`);

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
        events: [],
      };
    }

    // 3. 取「上次巩固结束之后」的消息
    // 游标按消息 id 锚定（见 resolveCursor），消息被删除不会让游标错位
    const { consolidation_window_turns } = getThresholds();
    const windowSize = consolidation_window_turns * 2;
    // 常规：从游标一路补到消息末尾——触发时刚完成的这几轮就是本次要沉淀的材料。
    // 不能给尾部预留固定窗口（len-windowSize）：那会让提取永远落后一轮，
    // 且游标一旦因补巩固批数上限 / 删消息滞后，预留窗会把刚聊的新对话整体圈走，
    // 退化成「只提取一两条陈年消息」（2026-10-12 现场：287 条只提取到 1 条 03:41 的旧消息）
    // catchUp（启动补巩固）：积压可能很长，每批至多一个窗口，分批消化
    const windowStart = opts?.catchUp
      ? Math.min(recentMessages.length, resolveCursor(recentMessages) + windowSize)
      : recentMessages.length;
    const start = Math.min(resolveCursor(recentMessages), windowStart);
    const windowMessages = recentMessages.slice(start, windowStart);
    // 游戏回合由游戏自己的巩固写入记忆，这里跳过，避免重复记账。
    // 注意：被跳过的只是「不参与提取」，游标仍会推进——否则一整段对局会让巩固反复空转
    const snapshot = windowMessages.filter((m) => !m.game_id);
    // 批末消息时间 = 这批对话实际发生的时刻：提取提示词与落库时间戳都用它，
    // 避免把历史对话当成「现在」巩固（否则几天前的事被写成「今天」）
    const batchEndTs =
      windowMessages[windowMessages.length - 1]?.timestamp ?? dayjs().toISOString();
    logDebug(
      "巩固范围",
      `${opts?.catchUp ? "补巩固" : "常规"} start=${start}, windowStart=${windowStart}, 窗口${windowMessages.length}条，剔除游戏回合后提取${snapshot.length}条，批末时间=${dayjs(batchEndTs).format("MM-DD HH:mm")}`
    );

    // 4. 取已有索引事件（供 LLM 判断挂靠，包含默认事件）
    const existingEvents = getTopActive(20);
    const defaultEventId = getDefaultEventId();
    if (defaultEventId) {
      const defaultEvent = getEventById(defaultEventId);
      if (defaultEvent) {
        existingEvents.unshift(defaultEvent); // 默认事件放最前面
      }
    }

    // 4b. 每个事件取最近 3 条片段摘要（一次 IN 查询，让 LLM 知道已提取过什么）
    const fragmentMap = getFragmentsByEventIds(existingEvents.map((e) => e.id));
    const eventFragments = new Map<number, string[]>();
    for (const [eventId, frags] of fragmentMap) {
      eventFragments.set(
        eventId,
        frags.slice(-3).map((f) => f.summary),
      );
    }

    // 窗口外没有新消息，跳过提取
    if (snapshot.length === 0) {
      logDebug("巩固跳过", "窗口外无新消息");
      clearTimeout(timeoutTimer);
      useMetaStore.getState().setLocked(false);
      // 游标仍要推进：窗口里全是游戏回合时（游戏自己的巩固已经记账了）
      // 不推进会让同一段对局反复空转，卡住巩固进度
      if (windowMessages.length > 0) advanceCursor(recentMessages, windowStart);
      // 仍清零计数器，避免反复触发
      useMetaStore.getState().reset();
      return true;
    }

    // 5. 调用后台 LLM 提取（增量模式，传 userInfo 供展示已有数据）
    const result = await extractConsolidation(userInfo, snapshot, existingEvents, eventFragments, LOCK_TIMEOUT_MS - 2000, batchEndTs);
    if (!result) {
      logDebug("巩固结果", "LLM 提取失败或返回空, is_locked=false, 保留计数器下次重试");
      clearTimeout(timeoutTimer);
      useMetaStore.getState().setLocked(false);
      return false;
    }

    // 6. 双重关联写入（SQLite 事务）
    const db = getDB();
    const written: string[] = [];
    await db.withExclusiveTransactionAsync(async () => {
      // 6a. Merge user_info（增量模式，new_info 只含新发现的字段）
      // nickname 的真相源即此处的 user_info.basic_identity，无需额外写入 AsyncStorage。
      // 状态/事件的时间戳同样沿用批末消息时间，不记成巩固执行时刻
      mergeUserInfo(result.new_info, batchEndTs);

      // 6b. 逐条写入片段（一次巩固可能覆盖多个话题）
      for (const frag of result.new_fragments ?? []) {
        const priority = frag.priority || 5;
        let targetEventId: number;

        if (frag.target_event_index > 0 && getEventById(frag.target_event_index)) {
          // LLM 指定了已有事件 ID（无效 ID 回落，避免写进悬空事件）
          targetEventId = frag.target_event_index;
        } else if (frag.new_event_text?.trim()) {
          // 先查语义重复的事件，避免「一起玩游戏」和「玩游戏」各建一个
          const similar = findSimilarEvent(frag.new_event_text.trim());
          if (similar) {
            targetEventId = similar.id;
          } else {
            targetEventId = insertEvent(frag.new_event_text.trim(), 100, priority, "episode", batchEndTs);
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

        insertFragment(targetEventId, frag.gist, frag.summary, priority, (frag.keywords ?? []).join(","), batchEndTs);
        updateEventPriority(targetEventId, priority);
        written.push(`  · [${targetEventId}] ${frag.gist}`);
      }
    });

    clearTimeout(timeoutTimer);

    // 6. 释放锁 + 清零计数 + 记录巩固进度（同步更新内存 + DB）
    advanceCursor(recentMessages, windowStart);
    useMetaStore.getState().reset();

    logDebug("巩固完成", `${written.join("\n")}\n进度: 已推进到第 ${windowStart} 条`);
    return true;
  } catch (err) {
    clearTimeout(timeoutTimer);
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("巩固异常", `${errMsg}\nis_locked=false, 保留计数器下次重试`);
    useMetaStore.getState().setLocked(false);
    return false;
  }
}

// 每次 App 进程只补一次（模块级守卫，聊天页重挂载不重复触发）
let catchUpStarted = false;

/**
 * 会话启动补巩固：把上次没来得及巩固的历史静默补上
 *
 * - 不阻塞输入：后台分批跑，每批一个巩固窗口，最多 CATCH_UP_MAX_BATCHES 批
 * - 时间戳沿用对话时间：写库与提取提示词都用该批最后一条消息的时间
 * - LLM 失败、锁被占或游标不推进即停，剩余积压下次启动续跑
 * - 只补「启动时刻之前」的历史：补巩固要跑好几批（每批一次 LLM），
 *   期间用户可能已经在聊天，刚发的消息和 AI 回复属于本次会话的进行中窗口，
 *   必须留给常规巩固流——绝不能被补巩固当场提取
 */
export async function runCatchUpConsolidation(): Promise<void> {
  if (catchUpStarted) return;
  catchUpStarted = true;

  // 边界时刻要在等水合之前取：水合期间用户发的消息同样不能进批次
  const boundaryTs = Date.now();

  await waitForMessagesHydration();

  if (!hasApiKey()) {
    logDebug("补巩固跳过", "未配置 API Key，本次启动不补巩固");
    return;
  }

  // 固定积压快照：整个补巩固过程只认启动前的消息，中途新消息一律不进批次
  const backlog = useChatStore
    .getState()
    .messages.filter((m) => dayjs(m.timestamp).valueOf() < boundaryTs);

  for (let i = 0; i < CATCH_UP_MAX_BATCHES; i++) {
    if (!hasPendingConsolidation(backlog)) {
      if (i === 0) logDebug("补巩固", "无积压历史，跳过");
      return;
    }
    // 正常巩固流持锁时不抢锁
    if (getMeta("is_locked") === "true") {
      logDebug("补巩固中止", "巩固锁被占用，剩余积压下次启动续跑");
      return;
    }
    const cursorBefore = resolveCursor(backlog);
    const ok = await runConsolidation(backlog, { catchUp: true });
    if (!ok) {
      logDebug("补巩固中止", "本批提取失败，剩余积压下次启动续跑");
      return;
    }
    // 兜底：游标没推进就别空转死循环
    if (resolveCursor(backlog) <= cursorBefore) {
      logDebug("补巩固中止", "游标未推进，避免空转");
      return;
    }
  }
  logDebug("补巩固", `已达单次启动上限（${CATCH_UP_MAX_BATCHES} 批），剩余积压下次启动续跑`);
}
