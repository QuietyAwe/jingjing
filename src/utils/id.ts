// ============================================================
// 全局唯一消息 id 生成器
//
// 旧实现 `dayjs().valueOf().toString()` 是毫秒时间戳：
// 同一 tick 内连续 addMessage（如游戏里 user 消息 + system 提示同帧追加）
// 必然撞 id，导致 FlatList/ChatBubble 的 React key 重复、
// 长按删除/编辑按 id 过滤时误伤同 id 的另一条消息。
//
// 新格式：`${Date.now()}-${seq}-${random}`，跨重启/跨设备唯一，
// 且仍是不透明字符串——旧持久化消息的纯数字 id 无需迁移。
// ============================================================

let seq = 0;

export function genMsgId(): string {
  seq = (seq + 1) % 1_000_000;
  return `${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}
