// ============================================================
// 20问的 Prompt 拼装
//
// 拆成两段，契合现有的缓存优化结构：
// - 游戏区（稳定）：角色 + 规则 + 谜底，一局之内不变，放在记忆区之前
// - 进度提示（易变）：第几问 + 已问清单，放在历史之后
// ============================================================

import type { GameSession, GameTurn } from "@/types/schema";
import { parseGameTurns } from "@/db/queries";
import { MAX_QUESTIONS } from "./twentyQuestions";

/**
 * 游戏区（稳定段）：只在一局内保持不变的内容
 * @param ended 本回合已终局时传 true，标题不再写「进行中」，与结束提示保持一致
 */
export function buildGameSection(session: GameSession, ended = false): string {
  const askedList = parseGameTurns(session)
    .filter((t) => t.intent === "question" || t.intent === "guess")
    .map((t) => `Q：${t.text} → ${t.answer ?? (t.correct ? "猜中" : "没猜中")}`)
    .join("\n");

  return [
    ended ? `## 游戏：20问（已结束）` : `## 游戏：20问（进行中）`,
    `你心里想好了一个谜底，玩家要通过只能回答是/否的问题在 ${MAX_QUESTIONS} 次提问内猜出它。`,
    ``,
    `【谜底（绝不能直接说出口）】${session.secret}`,
    session.secret_source === "memory"
      ? `（这个谜底来自你们的共同记忆，如果玩家猜中，可以自然地聊聊这段记忆）`
      : `（这是大众熟悉的题材，猜中后可以聊聊为什么选它）`,
    ``,
    `【规则】`,
    `- 只能回答「是 / 不是 / 不好说」，但要用你自己的语气说出来，可以带一句吐槽或联想`,
    `- 答案必须始终一致，不能前后矛盾`,
    `- 玩家闲聊、吐槽、要提示时不算提问次数，你可以正常陪他聊`,
    `- 玩家直接猜或投降就结束本局`,
    ``,
    `【已问过的问题】`,
    askedList || "（还没有问过）",
  ].join("\n");
}

/**
 * 进度提示（易变段）：放在历史之后，避免影响前缀缓存
 *
 * 注意：剩余次数由界面显示（系统提示），AI 不要主动报数，
 * 只在规则查询时说明一次即可。
 */
export function buildGameProgressHint(session: GameSession, latest?: GameTurn): string {
  const left = Math.max(0, MAX_QUESTIONS - session.question_count);

  if (latest?.intent === "question") {
    const answerWord =
      latest.answer === "yes" ? "是" : latest.answer === "no" ? "不是" : "不好说";
    return [
      `本回合判定结果：${answerWord}${latest.reason ? `（${latest.reason}）` : ""}`,
      `请用你自己的话把这个答案说出来，不要生硬地只回一个字。`,
      `不要主动告诉玩家还剩几次提问机会（界面已经显示），也不要每句话都报数。`,
    ].join("\n");
  }

  if (latest?.intent === "guess") {
    return latest.correct
      ? `玩家猜中了！请开心地揭晓：谜底就是「${session.secret}」，并自然地聊几句。`
      : `玩家猜的不是。请委婉地否定，鼓励他继续问（不用报剩余次数）。`;
  }

  if (latest?.intent === "rule_query") {
    return `玩家在问规则或剩余次数，可以说明还剩 ${left} 次提问机会、闲聊不计入次数。`;
  }

  if (latest?.intent === "give_up") {
    return `玩家投降了。请揭晓谜底：「${session.secret}」，并聊聊为什么选它，然后自然地接回日常聊天。`;
  }

  return `（游戏中，还剩 ${left} 次提问机会；这是闲聊，不计入次数，正常陪他聊完可以顺带回一句继续游戏）`;
}

/**
 * 开场提示：玩家刚发起一局
 *
 * 规则已由系统提示说明，AI 不要重复规则，只做简短回应，
 * 让玩家觉得是"我说要玩 → 它接住了"的自然交流。
 */
export function buildGameStartHint(session: GameSession): string {
  return [
    `玩家刚刚发起了这局 20问，你心里已经想好谜底：「${session.secret}」。`,
    `规则玩家已经看到了，你不要重复规则。`,
    `只说一两句简短的话：宣布你想好了，可以顺带提示一下类别范围（比如"是个人物""是个地方"）以降低开局难度，`,
    `然后邀请他问第一个问题。不要说出谜底本身。`,
  ].join("\n");
}

/** 揭晓提示：投降或超时 */
export function buildGameRevealHint(session: GameSession): string {
  return [
    `本局结束，请揭晓谜底：「${session.secret}」。`,
    `用你自己的话说出来，可以聊聊为什么选它，然后自然地接回日常聊天。`,
  ].join("\n");
}
