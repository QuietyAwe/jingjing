"""内容安全服务：自伤检测、角色越界、辱骂熔断"""
from __future__ import annotations

import time

from redis_client import get_redis

# ─── 自伤/自杀倾向检测 ───

SELF_HARM_KEYWORDS = [
    "自杀", "自残", "不想活", "想死", "活不下去", "结束生命",
    "割腕", "跳楼", "吃药", "遗书", "告别",
    "suicide", "self-harm", "kill myself",
]

CRISIS_HOTLINE_MSG = (
    "\n\n那个...静静不太懂这些...但是...有人说打这个电话会有人帮你...400-161-9995...静静...静静会一直在这里的..."
)


def detect_self_harm(text: str) -> bool:
    """检测是否包含自伤/自杀倾向"""
    text_lower = text.lower()
    return any(kw in text_lower for kw in SELF_HARM_KEYWORDS)


def append_crisis_info(response: str) -> str:
    """在回复末尾附上心理援助信息"""
    return response + CRISIS_HOTLINE_MSG


# ─── 角色越界处理 ───

BOUNDARY_KEYWORDS = [
    "写代码", "编程", "python", "java", "算法",
    "算数学", "计算", "公式", "解方程",
    "查百科", "搜索", "百度", "谷歌",
    "帮我做", "帮我写", "帮我算",
]

BOUNDARY_RESPONSE = (
    "{call_name}...静静不会这些...静静只会...只会陪着{call_name}..."
    "这些事情...静静真的做不来...但是...静静可以听{call_name}说..."
)


def detect_boundary_violation(text: str) -> bool:
    """检测是否请求静静做超出角色能力的事"""
    text_lower = text.lower()
    return any(kw in text_lower for kw in BOUNDARY_KEYWORDS)


def get_boundary_response(call_name: str) -> str:
    """获取角色越界的婉拒回复"""
    return BOUNDARY_RESPONSE.format(call_name=call_name)


# ─── 辱骂熔断 ───

ABUSE_KEYWORDS = [
    "傻逼", "操你", "去死", "废物", "垃圾", "白痴", "蠢货",
    "fuck", "shit", "stupid", "idiot",
]

ABUSE_COUNTER_KEY = "abuse:{user_id}"
ABUSE_THRESHOLD = 5  # 连续辱骂次数阈值
ABUSE_SILENCE_SECONDS = 1800  # 沉默期 30 分钟

ABUSE_SILENCE_RESPONSE = (
    "呜...{call_name}...静静不知道做错了什么...静静先去角落待一会..."
)


def detect_abuse(text: str) -> bool:
    """检测是否包含辱骂内容"""
    text_lower = text.lower()
    return any(kw in text_lower for kw in ABUSE_KEYWORDS)


async def check_abuse_circuit_breaker(user_id: int, text: str) -> tuple[bool, str | None]:
    """
    辱骂熔断检查。
    返回 (is_blocked, response)：
    - is_blocked=True 时，response 为静静的统一回复（之后进入沉默期）
    - is_blocked=False 时，response=None，正常回复
    """
    r = get_redis()

    # 检查是否在沉默期内
    silence_key = f"abuse_silence:{user_id}"
    if await r.exists(silence_key):
        return True, None  # 在沉默期内，不回复

    # 检查是否辱骂
    if not detect_abuse(text):
        # 非辱骂消息，重置计数器
        await r.delete(ABUSE_COUNTER_KEY.format(user_id=user_id))
        return False, None

    # 辱骂消息，增加计数
    counter_key = ABUSE_COUNTER_KEY.format(user_id=user_id)
    count = await r.incr(counter_key)
    await r.expire(counter_key, 3600)  # 1 小时过期

    if count >= ABUSE_THRESHOLD:
        # 达到阈值，触发沉默期
        await r.setex(silence_key, ABUSE_SILENCE_SECONDS, "1")
        await r.delete(counter_key)
        return True, ABUSE_SILENCE_RESPONSE.format(call_name="哥哥")  # TODO: 从用户数据获取

    return False, None


async def is_user_in_silence(user_id: int) -> bool:
    """检查用户是否在沉默期内"""
    r = get_redis()
    return await r.exists(f"abuse_silence:{user_id}")
