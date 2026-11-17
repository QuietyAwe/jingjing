// ============================================================
// 情境旁白：用户开口或 AI 主动开场前，补一条「当下在哪、是什么状态」的注记
//
// 角色仍是 user（界面不显示），靠 [旁白] 前缀与真实发言区分。
// ============================================================

import dayjs from "dayjs";
import { getUserInfo } from "@/db/queries";
import { getCurrentScene, formatSceneNote } from "@/memory/scheduler";
import { useChatStore } from "@/store/chatStore";
import { genMsgId } from "@/utils/id";

/** 距上一条旁白不足此时长就不再写：实况刷新会改文案，但同一处境不该注两次 */
const NOTE_GAP_MINUTES = 15;

/** 状态变了才追加；没有画像或没有当前场景时不写 */
export function appendStateNote(): void {
  if (!getUserInfo()) return;
  const scene = getCurrentScene();
  if (!scene) return;
  const messages = useChatStore.getState().messages;
  const last = [...messages].reverse().find((m) => m.is_state_note);
  // 刚注入过就跳过：主动开场写了旁白、用户紧接着回复时，实况虽被刷新，情境没变，不重复写
  if (last?.timestamp && dayjs().diff(dayjs(last.timestamp), "minute") < NOTE_GAP_MINUTES) return;
  // 上一格的旁白如果还在当前上下文里，就不再重复写一遍
  const history = useChatStore.getState().getHistory();
  const content = `[旁白] ${formatSceneNote(scene, undefined, (text) =>
    history.some((m) => m.is_state_note && m.content.includes(text))
  )}`;
  if (last?.content === content) return;
  useChatStore.getState().addMessage({
    id: genMsgId(),
    role: "user",
    content,
    timestamp: dayjs().toISOString(),
    is_state_note: true,
  });
}
