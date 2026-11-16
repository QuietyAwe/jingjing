// ============================================================
// AI 主动开场：用户离开一段时间后回来，由 AI 先开口
//
// 只在进入首页时判定（手机端没有可靠后台），一天最多一次。
// 开场消息照常落库，用户没进聊天页就会在首页显示未读。
// ============================================================

import dayjs from "dayjs";
import type { Dayjs } from "dayjs";
import { getMeta, setMeta } from "@/db/queries";
import type { ChatMessage } from "@/types/schema";
import { buildChatContext } from "@/memory/chatHandler";
import { appendStateNote } from "@/memory/stateNote";
import { streamChat } from "@/llm/foreground";
import { useChatStore } from "@/store/chatStore";
import { genMsgId } from "@/utils/id";

/** 距最后一条消息超过这么久，才值得由 AI 先开口 */
const GAP_HOURS = 3;
const META_KEY = "last_proactive_at";

/** 追加在消息末尾（与事件提醒同一写法），不改动前面的缓存前缀 */
const OPENING_INSTRUCTION =
  "没有人开口。你主动说一句话——一句就够：贴合此刻的情境和你们的关系，不要提问轰炸、不要复述场景、不要解释自己为什么开口。";

/**
 * 是否该主动开场。
 *
 * 判据只看对话状态，不看内容：最后一句是 AI 说的、且已过去足够久，
 * 说明用户离开了，此刻回来由 AI 接一句才自然。
 */
export function shouldOpenProactively(messages: ChatMessage[], now: Dayjs = dayjs()): boolean {
  const real = messages.filter(
    (m) => !m.friend_id && !m.is_state_note && m.role !== "system"
  );
  // 用户至少说过一句话：未自我介绍前由冷启动流程负责，不抢跑
  if (!real.some((m) => m.role === "user")) return false;

  const last = real[real.length - 1];
  // 最后一句是用户说的，说明还没回复完，不插话
  if (!last || last.role !== "assistant") return false;
  // 报错气泡不当作「AI 说完了」
  if (last.content.startsWith("⚠️")) return false;

  if (now.diff(dayjs(last.timestamp), "hour", true) < GAP_HOURS) return false;

  const done = getMeta(META_KEY);
  if (done && dayjs(done).isSame(now, "day")) return false;
  return true;
}

/** 记下今天已经主动开场过（失败也算，避免同一天反复重试） */
export function markProactiveDone(at: Dayjs = dayjs()): void {
  setMeta(META_KEY, at.toISOString());
}

let opening = false;

/**
 * 执行一次主动开场：补旁白 → 生成一句 → 落库。
 *
 * 失败静默：不写错误气泡，用户看到的就是「AI 没说话」。
 */
export async function runProactiveOpening(): Promise<void> {
  if (opening) return;
  const store = useChatStore.getState();
  if (store.isLoading) return;
  if (!shouldOpenProactively(store.messages)) return;

  opening = true;
  markProactiveDone();
  store.setLoading(true);
  store.setStreamingText("");
  store.setStreamingThinking("");
  try {
    // 旁白先落库：既给开场提供当下情境，也让历史以 user 开头
    // （getHistory 会裁掉开头的 assistant 消息，AI 若是最先开口会被裁没）
    appendStateNote();
    const context = await buildChatContext("", useChatStore.getState().getHistory());
    context.messages.push({ role: "system" as const, content: OPENING_INSTRUCTION });

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
