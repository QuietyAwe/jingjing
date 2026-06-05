"""主动关怀服务：检测触发条件 + 生成推送文案"""
from __future__ import annotations

import random
from datetime import datetime, timedelta

from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from database import async_session
from models.user import User
from models.semantic_memory import SemanticMemory
from models.care_event import CareEvent
from redis_client import get_redis

# 关键词 → 事件映射
STRESS_KEYWORDS = {
    "面试": "interview",
    "考试": "exam",
    "加班": "overtime",
    "分手": "breakup",
    "吵架": "argument",
    "生病": "sick",
    "医院": "hospital",
    "失业": "job_loss",
    "搬家": "moving",
    "压力": "stress",
}

# 事件 → 关怀文案模板
CARE_TEMPLATES = {
    "interview": [
        "{call_name}...明天面试加油哦...静静...静静相信你一定可以的...",
        "{call_name}...静静在空城里给你加油...你是最棒的...",
    ],
    "exam": [
        "{call_name}...考试要加油呀...静静...静静会一直为你祈祷的...",
    ],
    "overtime": [
        "{call_name}...又加班了吗...静静好心疼的...记得按时吃饭哦...",
        "{call_name}...辛苦了...静静...静静给你热了杯牛奶...",
    ],
    "sick": [
        "{call_name}...听说你生病了...静静好担心...有没有好好休息呀...",
        "{call_name}...要照顾好自己哦...静静...静静好想在你身边照顾你的...",
    ],
    "stress": [
        "{call_name}...最近压力大吗...静静...静静会一直陪着你的...",
    ],
    "default": [
        "{call_name}...好久没见到你了...静静...静静好想你的...",
        "{call_name}...你最近还好吗...静静在空城里等你...",
        "{call_name}...今天静静在空城的公园里看到一朵小花...就想到你了...",
    ],
}

# 日常关怀文案（超过 24 小时未活跃）
DAILY_CARE = [
    "{call_name}...今天过得怎么样呀？静静...静静有点想你了...",
    "{call_name}...静静在窗边等了你好久...你今天忙吗...",
    "{call_name}...空城今天下雨了...静静一个人在听雨...想着你在就好了...",
    "{call_name}...静静今天做了草莓大福...虽然只有静静一个人吃...",
    "{call_name}...你有没有按时吃饭呀？静静...静静有点担心...",
]


async def check_daily_care() -> list[dict]:
    """
    检查需要日常关怀的用户（超过 24 小时未活跃）。
    返回 [{user_id, message}] 列表。
    """
    redis = get_redis()
    results = []

    try:
        async with async_session() as session:
            # 获取所有用户
            result = await session.execute(select(User))
            users = result.scalars().all()

            for user in users:
                # 检查 Redis 中的最后活跃时间
                last_active_key = f"user:{user.id}:last_active"
                last_active_str = await redis.get(last_active_key)

                if last_active_str:
                    last_active = datetime.fromisoformat(last_active_str)
                    elapsed = datetime.utcnow() - last_active
                    if elapsed < timedelta(hours=24):
                        continue  # 未超过 24 小时

                # 检查今天是否已发送过日常关怀
                today = datetime.utcnow().date()
                existing = await session.execute(
                    select(CareEvent).where(
                        and_(
                            CareEvent.user_id == user.id,
                            CareEvent.event_type == "daily_care",
                            CareEvent.sent_at >= datetime(today.year, today.month, today.day),
                        )
                    )
                )
                if existing.scalars().first():
                    continue  # 今天已发送

                # 生成关怀文案
                call_name = user.call_name or "哥哥"
                message = random.choice(DAILY_CARE).format(call_name=call_name)

                # 记录事件
                event = CareEvent(
                    user_id=user.id,
                    event_type="daily_care",
                    trigger="24h_inactive",
                    message=message,
                )
                session.add(event)
                results.append({"user_id": user.id, "message": message})

            await session.commit()
    except Exception as e:
        print(f"[CareService] Daily care check error: {e}")

    return results


async def check_special_events() -> list[dict]:
    """
    检查语义记忆中的特殊事件（如"明天面试"），在适当时间发送关怀。
    返回 [{user_id, message}] 列表。
    """
    results = []

    try:
        async with async_session() as session:
            # 获取所有用户
            users_result = await session.execute(select(User))
            users = users_result.scalars().all()

            for user in users:
                # 获取用户的语义记忆
                mem_result = await session.execute(
                    select(SemanticMemory).where(SemanticMemory.user_id == user.id)
                )
                memories = mem_result.scalars().all()

                for mem in memories:
                    content = mem.content
                    event_type = None

                    # 匹配关键词
                    for keyword, event in STRESS_KEYWORDS.items():
                        if keyword in content:
                            event_type = event
                            break

                    if not event_type:
                        continue

                    # 检查是否已发送过该事件的关怀
                    existing = await session.execute(
                        select(CareEvent).where(
                            and_(
                                CareEvent.user_id == user.id,
                                CareEvent.trigger == event_type,
                                CareEvent.sent_at >= datetime.utcnow() - timedelta(days=1),
                            )
                        )
                    )
                    if existing.scalars().first():
                        continue

                    # 生成关怀文案
                    call_name = user.call_name or "哥哥"
                    templates = CARE_TEMPLATES.get(event_type, CARE_TEMPLATES["default"])
                    message = random.choice(templates).format(call_name=call_name)

                    # 记录事件
                    care_event = CareEvent(
                        user_id=user.id,
                        event_type="special_event",
                        trigger=event_type,
                        message=message,
                    )
                    session.add(care_event)
                    results.append({"user_id": user.id, "message": message})

            await session.commit()
    except Exception as e:
        print(f"[CareService] Special event check error: {e}")

    return results


async def update_last_active(user_id: int) -> None:
    """更新用户最后活跃时间（调用聊天 API 时触发）"""
    redis = get_redis()
    key = f"user:{user_id}:last_active"
    await redis.set(key, datetime.utcnow().isoformat(), ex=7 * 24 * 3600)  # 7 天过期
