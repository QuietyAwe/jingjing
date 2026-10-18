// ============================================================
// 动态刷新总线
//
// 单独成文件是为了断开循环依赖：moments/service 与 friends/service
// 都要能「落库后通知 UI 刷新」，但两者互相 import 会成环。
// ============================================================

type Listener = () => void;

const listeners = new Set<Listener>();

/** 订阅动态数据变化（AI/好友发帖或评论落库后刷新 UI），返回取消订阅函数 */
export function subscribeMomentUpdates(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function notifyMomentUpdates(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.error("[moments] 刷新回调异常:", err);
    }
  }
}
