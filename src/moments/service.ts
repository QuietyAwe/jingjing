// ============================================================
// 心情动态服务层：发帖/评论写入 + AI 互动触发（真人感随机延迟）
//
// 真人感三层：
// 1. 概率层——AI 不是每条动态都评论（阈值可配）
// 2. 延迟层——回评约 3~15s，主动评论约 30s~3min（基准 ± 抖动）
// 3. 放弃层——LLM 失败就当刷过去了，不重试不补发
// ============================================================

import {
  insertMoment,
  insertMomentComment,
  getMomentById,
  getMomentComments,
} from "@/db/queries";
import { generateMomentComment } from "@/llm/background";
import { getPrompts, getThresholds } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { recordUserMomentMemory, recordMomentExchangeMemory } from "@/moments/memory";

type Listener = () => void;

const listeners = new Set<Listener>();
/** AI 正在构思评论的动态 ID（UI 显示「正在输入」三点动效） */
const aiTypingMoments = new Set<number>();
/** 已排队的 AI 评论 key（momentId:replyTo），防同一互动重复触发 */
const pendingKeys = new Set<string>();

/** 订阅动态数据变化（AI 发帖/评论落库后刷新 UI），返回取消订阅函数 */
export function subscribeMomentUpdates(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.error("[moments] 刷新回调异常:", err);
    }
  }
}

/** 外部（发帖调度引擎）落库动态后触发 UI 刷新 */
export function notifyMomentUpdates(): void {
  notify();
}

/** 该动态上是否有 AI 评论正在生成 */
export function isAiTypingOn(momentId: number): boolean {
  return aiTypingMoments.has(momentId);
}

/** 人性化随机延迟：base × [minMult, maxMult] 均匀抖动 */
function randomDelay(baseMs: number, minMult: number, maxMult: number): number {
  const mult = minMult + Math.random() * (maxMult - minMult);
  return Math.round(baseMs * mult);
}

/** 用户发一条心情动态 */
export function postUserMoment(content: string, mood: string): number {
  const id = insertMoment("user", content.trim(), mood);
  logDebug("动态", `用户发布动态 #${id}（${mood}）`);
  notify();
  // 用户的心情即刻进记忆（即使本次没有互动，之后也要记得）
  recordUserMomentMemory(id);
  // AI 有概率来评论（真人不会每条都评）
  maybeAiCommentOnUserMoment(id);
  return id;
}

/** 用户评论某条动态 */
export function addComment(momentId: number, content: string): number {
  const id = insertMomentComment(momentId, "user", content.trim());
  logDebug("动态", `用户评论动态 #${momentId}`);
  notify();

  const moment = getMomentById(momentId);
  if (!moment) return id;

  if (moment.author === "ai") {
    // 自己动态下收到评论：随机延迟回评
    scheduleAiComment(momentId, content.trim(), replyDelayMs());
  } else {
    maybeAiCommentOnUserMoment(momentId);
  }
  return id;
}

/** 主动评论用户动态：概率 + 长延迟（30s~3min 量级） */
function maybeAiCommentOnUserMoment(momentId: number): void {
  const { moment_ai_comment_probability, moment_ai_reply_delay_ms } = getThresholds();
  if (Math.random() >= moment_ai_comment_probability) {
    logDebug("动态", `本次不评论动态 #${momentId}（概率未命中）`);
    return;
  }
  scheduleAiComment(momentId, undefined, randomDelay(moment_ai_reply_delay_ms, 4, 22));
}

/** 回评延迟：约 3~15s */
function replyDelayMs(): number {
  const { moment_ai_reply_delay_ms } = getThresholds();
  return randomDelay(moment_ai_reply_delay_ms, 0.4, 1.9);
}

/** 排队一条 AI 评论（带延迟与「正在输入」状态；同 key 防重） */
function scheduleAiComment(momentId: number, replyTo: string | undefined, delayMs: number): void {
  const key = `${momentId}:${replyTo ?? ""}`;
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);

  setTimeout(() => {
    pendingKeys.delete(key);
    aiTypingMoments.add(momentId);
    notify();
    runAiComment(momentId, replyTo)
      .catch((err) => console.error("[moments] AI 评论异常:", err))
      .finally(() => {
        aiTypingMoments.delete(momentId);
        notify();
      });
  }, delayMs);
}

/** 生成并落库一条 AI 评论；失败静默放弃（不重试，像真人刷过去就刷过去了） */
async function runAiComment(momentId: number, replyTo?: string): Promise<void> {
  const moment = getMomentById(momentId);
  if (!moment) return;

  const comments = getMomentComments(momentId);
  const { system_prompt } = getPrompts();
  const text = await generateMomentComment(system_prompt, {
    moment: { author: moment.author, content: moment.content, mood: moment.mood },
    comments: comments.map((c) => ({ author: c.author, content: c.content })),
    replyTo,
  });

  if (!text) {
    logDebug("动态", `AI 评论生成失败，放弃: #${momentId}`);
    return;
  }

  insertMomentComment(momentId, "ai", text);
  logDebug("动态", `AI 评论动态 #${momentId}：${text.slice(0, 30)}`);
  notify();
  // 互动闭环：动态 + 评论来往一起计入记忆（不等巩固流）
  recordMomentExchangeMemory(momentId);
}
