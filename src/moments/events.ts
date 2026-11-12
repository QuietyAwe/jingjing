// ============================================================
// 动态相关记忆的事件标题
//
// 写入方（moments/memory.ts）、灵光一闪新近度加权（memory/retrieval.ts）
// 与历史数据迁移/补别名（db/queries.ts）共用同一份常量，
// 避免几处字符串各写一份又悄悄漂移。
// 纯常量，不依赖 DB / LLM，可被任何模块安全 import。
// ============================================================

/** 用户发的动态（含其下的评论互动） */
export const EVENT_USER_MOMENT = "[user]的心情动态";
/** AI 自己发的动态（含其下的评论互动） */
export const EVENT_AI_MOMENT = "我的心情动态";
/** 好友发的动态及其下的互动 */
export const EVENT_FRIEND_FEED = "朋友圈日常";

/** 按帖子作者取归属事件：一条动态的记忆挂到发帖人对应的事件下 */
export function momentEventOf(author: "user" | "ai" | "friend"): string {
  if (author === "ai") return EVENT_AI_MOMENT;
  if (author === "friend") return EVENT_FRIEND_FEED;
  return EVENT_USER_MOMENT;
}

/** 三个动态事件共用的口语别名（检索按「标题或别名」粗召回） */
export const MOMENT_EVENT_ALIASES = ["朋友圈", "动态", "帖子"];
