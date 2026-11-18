// ============================================================
// AI 主动开场：用户离开一段时间后回来，由 AI 先开口
//
// 只在进入首页时判定（手机端没有可靠后台），每天最多判定一次。
// 开场消息照常落库，用户没进聊天页就会在首页显示未读。
// ============================================================

import dayjs from "dayjs";
import type { Dayjs } from "dayjs";
import { getMeta, setMeta, getUserInfo } from "@/db/queries";
import type { ChatMessage } from "@/types/schema";
import { buildChatContext } from "@/memory/chatHandler";
import { appendStateNote } from "@/memory/stateNote";
import { streamChat } from "@/llm/foreground";
import { logDebug, useChatStore } from "@/store/chatStore";
import { genMsgId } from "@/utils/id";

/** 最短静默时长；之后按时间逐步提高主动开口概率 */
const MIN_GAP_HOURS = 2;
/** 达到这个时长必定开口 */
const FULL_CHANCE_HOURS = 48;
const MIN_CHANCE = 0.05;
const META_KEY = "last_proactive_at";

/** 随时间线性升高：2 小时 5%，48 小时 100%。 */
export function getProactiveChance(hoursAway: number): number {
  if (hoursAway < MIN_GAP_HOURS) return 0;
  if (hoursAway >= FULL_CHANCE_HOURS) return 1;
  const progress = (hoursAway - MIN_GAP_HOURS) / (FULL_CHANCE_HOURS - MIN_GAP_HOURS);
  return MIN_CHANCE + progress * (1 - MIN_CHANCE);
}

/**
 * 生成主动开场的临时指令，追加在消息末尾（与事件提醒同一写法），不改动前面的缓存前缀。
 *
 * 这条 system 消息是 buildChatContext 之后追加的，不经过 replacePlaceholders，
 * 所以昵称在这里直接填好；[user] 占位符只在经过拼装层的提示词里才会被替换。
 */
function buildOpeningInstruction(hoursAway: number): string {
  const nickname = getUserInfo()?.basic_identity?.nickname || "用户";
  const away = hoursAway >= 48 ? `${Math.round(hoursAway / 24)}天` : `${hoursAway}小时`;
  return `${nickname}隔了${away}又打开应用。像平常突然想起对方一样自然地先开口：可以说说你此刻正在做的一件小事、刚看到的东西，或顺着上次的话题轻轻接一句。用一到两句短话，别只发空泛的问候，也不用每次都是两句。${nickname}没回消息只是各忙各的，别担心、别追问原因、别道歉，也别解释自己为什么现在开口。最多带一个轻松的问题，不要连着发问。`;
}

export interface ProactiveRoll {
  /** 今天是否具备掷骰资格（含每天一次的限制） */
  eligible: boolean;
  /** 距 AI 最后一条消息的静默时长 */
  hoursAway: number;
  chance: number;
  shouldOpen: boolean;
}

/**
 * 掷一次主动开场。
 *
 * 判据只看对话状态：最后一句是 AI 说的、至少隔了 2 小时、今天还没判定过。
 * 不中也要由调用方记下当天已判定，避免反复切回首页把 5% 刷成必发。
 */
export function rollProactiveOpening(
  messages: ChatMessage[],
  now: Dayjs = dayjs(),
  random: () => number = Math.random
): ProactiveRoll {
  const skip: ProactiveRoll = { eligible: false, hoursAway: 0, chance: 0, shouldOpen: false };
  const real = messages.filter(
    (m) => !m.friend_id && !m.is_state_note && m.role !== "system"
  );
  // 用户至少说过一句话：未自我介绍前由冷启动流程负责，不抢跑
  if (!real.some((m) => m.role === "user")) return skip;

  const last = real[real.length - 1];
  // 最后一句是用户说的，说明还没回复完，不插话
  if (!last || last.role !== "assistant") return skip;
  // 报错气泡不当作「AI 说完了」
  if (last.content.startsWith("⚠️")) return skip;

  const hoursAway = now.diff(dayjs(last.timestamp), "hour", true);
  if (hoursAway < MIN_GAP_HOURS) return skip;

  const done = getMeta(META_KEY);
  if (done && dayjs(done).isSame(now, "day")) return skip;

  const chance = getProactiveChance(hoursAway);
  return {
    eligible: true,
    hoursAway: Math.max(MIN_GAP_HOURS, Math.round(hoursAway)),
    chance,
    shouldOpen: random() < chance,
  };
}

/** 记下今天已经做过判定（无论是否真的发出，避免同一天反复重试） */
export function markProactiveDone(at: Dayjs = dayjs()): void {
  setMeta(META_KEY, at.toISOString());
}

let opening = false;

/**
 * 执行一次主动开场：补旁白 → 自然开口 → 落库。
 *
 * 概率未中或调用失败都静默：不写错误气泡，用户看到的就是「AI 没说话」。
 */
export async function runProactiveOpening(): Promise<void> {
  if (opening) return;
  const store = useChatStore.getState();
  if (store.isLoading) return;

  const roll = rollProactiveOpening(store.messages);
  if (!roll.eligible) return;
  // 先记下今天已经判定：随机不中时当天不再重掷
  markProactiveDone();
  logDebug(
    "主动开场",
    `间隔 ${roll.hoursAway} 小时，概率 ${Math.round(roll.chance * 100)}%，${roll.shouldOpen ? "本次触发" : "本次未触发"}`
  );
  if (!roll.shouldOpen) return;

  opening = true;
  store.setLoading(true);
  store.setStreamingText("");
  store.setStreamingThinking("");
  try {
    // 旁白先落库：既给开场提供当下情境，也让历史以 user 开头
    // （getHistory 会裁掉开头的 assistant 消息，AI 若是最先开口会被裁没）
    appendStateNote();
    const context = await buildChatContext("", useChatStore.getState().getHistory());
    context.messages.push({
      role: "system" as const,
      content: buildOpeningInstruction(roll.hoursAway),
    });

    let text = "";
    let thinking = "";
    await streamChat(context.messages, {
      onDelta: (delta) => {
        text += delta;
        useChatStore.getState().appendStreamingText(delta);
      },
      onThinking: (t) => {
        thinking += t;
        useChatStore.getState().appendStreamingThinking(t);
      },
      onDone: (finalText, finalThinking) => {
        if (finalText) text = finalText;
        if (finalThinking) thinking = finalThinking;
        const s = useChatStore.getState();
        s.setStreamingText("");
        s.setStreamingThinking("");
        s.addMessage({
          id: genMsgId(),
          role: "assistant",
          content: text,
          timestamp: dayjs().toISOString(),
          thinking: thinking || undefined,
        });
        s.setLoading(false);
      },
      onError: () => {
        const s = useChatStore.getState();
        s.setStreamingText("");
        s.setStreamingThinking("");
        s.setLoading(false);
      },
    });
  } catch {
    const s = useChatStore.getState();
    s.setStreamingText("");
    s.setStreamingThinking("");
    s.setLoading(false);
  } finally {
    opening = false;
  }
}
