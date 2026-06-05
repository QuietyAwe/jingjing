from __future__ import annotations

import json
from datetime import datetime

import redis.asyncio as redis

from config import get_settings

_redis: redis.Redis | None = None


async def init_redis() -> redis.Redis:
    """初始化 Redis 连接"""
    global _redis
    _redis = redis.from_url(
        get_settings().redis_url,
        decode_responses=True,
    )
    await _redis.ping()
    return _redis


async def close_redis():
    """关闭 Redis 连接"""
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None


def get_redis() -> redis.Redis:
    """获取 Redis 实例"""
    if _redis is None:
        raise RuntimeError("Redis 未初始化，请先调用 init_redis()")
    return _redis


# ─── Working Memory 工具函数 ───

WORKING_MEMORY_MAX_ROUNDS = 15


async def push_message(user_id: int, role: str, content: str) -> None:
    """将一条消息推入用户的 Working Memory 队列，保留最近 N 轮"""
    r = get_redis()
    key = f"wm:{user_id}"
    message = json.dumps({
        "role": role,
        "content": content,
        "timestamp": datetime.now().isoformat(),
    }, ensure_ascii=False)
    await r.lpush(key, message)
    await r.ltrim(key, 0, WORKING_MEMORY_MAX_ROUNDS - 1)


async def get_recent_messages(user_id: int, limit: int = WORKING_MEMORY_MAX_ROUNDS) -> list[dict]:
    """获取用户最近 N 条消息（按时间正序返回）"""
    r = get_redis()
    key = f"wm:{user_id}"
    messages = await r.lrange(key, 0, limit - 1)
    # LPUSH 最新的在前，需要反转为时间正序
    return [json.loads(m) for m in reversed(messages)]


async def clear_working_memory(user_id: int) -> None:
    """清除用户的 Working Memory"""
    r = get_redis()
    await r.delete(f"wm:{user_id}")
