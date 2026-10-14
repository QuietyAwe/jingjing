// ============================================================
// 20问游戏 — 状态机与流程编排
//
// 规则：
// - 模式 user_asks：AI 心里想一个，用户问是非问题来猜
// - 只有「是非问题」和「直接猜」计入 20 次，闲聊不计入
// - 猜中即胜；用满 20 次或投降即揭晓
// ============================================================

import dayjs from "dayjs";
import {
  createGameSession,
  getActiveGameSession,
  appendGameTurn,
  finishGameSession,
  parseGameTurns,
  insertEpisode,
  getGameSessionById,
  mergeUserInfo,
  updateGameResultNote,
} from "@/db/queries";
import { extractGameMemory } from "./memory";
import { logDebug } from "@/store/chatStore";
import type { GameSession, GameTurn, GameIntent } from "@/types/schema";
import { judgeUserInput, ruleJudge, type JudgeResult } from "./judge";
import { pickSubject } from "./subjectPicker";

export const MAX_QUESTIONS = 20;
export const GAME_TYPE = "twenty_questions" as const;

/** 已用提问数是否达到上限 */
export function isOutOfQuestions(session: GameSession): boolean {
  return session.question_count >= MAX_QUESTIONS;
}

/**
 * 开一局新游戏
 * @returns 会话，出题失败时返回 null
 */
export async function startGame(): Promise<GameSession | null> {
  const existing = getActiveGameSession();
  // 有进行中的对局时不再另开：同类型直接续用，异类型拒绝，防止双对局互相覆盖
  if (existing) return existing.game_type === GAME_TYPE ? existing : null;

  const subject = await pickSubject();
  if (!subject) return null;

  const id = createGameSession({
    gameType: GAME_TYPE,
    mode: "user_asks",
    secret: subject.secret,
    secretSource: subject.source,
  });
  logDebug("20问开始", `谜底=${subject.secret}（${subject.source}）`);
  return getGameSessionById(id);
}

/**
 * 处理玩家一句话，返回本回合结果
 * 只负责规则与判定，语气包装交给前台模型
 */
export async function handlePlayerInput(
  session: GameSession,
  userText: string
): Promise<{
  session: GameSession;
  turn: GameTurn;
  judge: JudgeResult;
  /** 本回合是否结束了游戏 */
  ended: boolean;
  endStatus?: "won" | "lost";
}> {
  const judged = (await judgeUserInput(session, userText)) ?? ruleJudge(userText);
  const intent: GameIntent = judged?.intent ?? "chitchat";

  const turn: GameTurn = {
    text: userText,
    intent,
    answer: intent === "question" ? judged?.answer ?? "unknown" : undefined,
    reason: judged?.reason,
    guess: intent === "guess" ? judged?.guess ?? userText : undefined,
    // 严格 === true：LLM 可能返回 "false" 等字符串，Boolean("false") 会把猜错判成猜中
    correct: intent === "guess" ? judged?.correct === true : undefined,
    at: dayjs().toISOString(),
  };

  // 只有是非问题与直接猜计入次数
  const counts = intent === "question" || intent === "guess";
  let updated = appendGameTurn(session.id, turn, counts ? 1 : 0) ?? session;

  let ended = false;
  let endStatus: "won" | "lost" | undefined;

  if (intent === "guess" && turn.correct) {
    endStatus = "won";
  } else if (intent === "give_up") {
    endStatus = "lost";
  } else if (counts && isOutOfQuestions(updated)) {
    endStatus = "lost";
  }

  if (endStatus) {
    finishGameSession(updated.id, endStatus, summarize(updated, endStatus));
    // 记忆提取含后台 LLM 调用，放后台跑不阻塞前台揭晓；
    // result_note 已由 finishGameSession 写入兜底小结，提取成功后会被更好的摘要覆盖
    writeGameMemory(updated, endStatus).catch((err) =>
      console.error("[20问] 游戏记忆写入异常:", err)
    );
    updated = getGameSessionById(updated.id) ?? updated;
    ended = true;
  }

  return { session: updated, turn, judge: judged ?? { intent }, ended, endStatus };
}

/** 生成对局小结文本 */
function summarize(session: GameSession, status: "won" | "lost"): string {
  const turns = parseGameTurns(session);
  const asked = turns.filter((t) => t.intent === "question" || t.intent === "guess").length;
  return status === "won"
    ? `玩家在第 ${asked} 次提问时猜中「${session.secret}」`
    : `玩家用了 ${asked} 次提问仍未猜中，谜底是「${session.secret}」`;
}

/**
 * 把对局写入长期记忆（episode 类型）
 * 由后台模型从整局流水里提取：既包含谜底与胜负，也包含过程中闲聊透露的内容。
 * 按天衰减 + 权重下限，很久以后仍可能被灵光一闪唤起。
 */
async function writeGameMemory(
  session: GameSession,
  status: "won" | "lost"
): Promise<void> {
  const turns = parseGameTurns(session);
  const asked = turns.filter((t) => t.intent === "question" || t.intent === "guess").length;
  const eventText = "一起玩20问";

  const extracted = await extractGameMemory(session, turns, status);

  // 情绪与细节一并写进 summary，不再单存 emotion 字段
  const summary =
    extracted?.summary ??
    (status === "won"
      ? `[user] [time]和我玩20问，谜底是「${session.secret}」，问到第 ${asked} 次就猜中了，挺得意，还想再来一局`
      : `[user] [time]和我玩20问，谜底是「${session.secret}」，问了 ${asked} 次也没猜出来，有点不甘心`);
  const priority = extracted?.priority ?? (status === "won" ? 8 : 7);
  const gist =
    extracted?.gist ??
    (status === "won"
      ? `[user]猜中了「${session.secret}」`
      : `[user]没猜出「${session.secret}」`);

  insertEpisode(eventText, gist, summary, priority, (extracted?.keywords ?? []).join(","));
  // 把摘要存到对局小结，供上下文合并使用（避免游戏问答污染上下文）
  updateGameResultNote(session.id, summary);

  // 闲聊里透露的新信息增量合并进画像（游戏问答本身不算）
  if (extracted?.new_info && Object.keys(extracted.new_info).length > 0) {
    mergeUserInfo(extracted.new_info);
  }

  logDebug("20问记忆", `已写入 episode 记忆：${summary}`);
}
