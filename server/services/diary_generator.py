"""镜像日记生成器：结合天气 + 记忆生成静静的日记"""
from __future__ import annotations

import json
import random
from datetime import datetime
from typing import Optional

import httpx

from config import get_settings
from database import async_session
from models.diary import DiaryEntry
from models.semantic_memory import SemanticMemory
from models.user import User
from sqlalchemy import select

# 配图标签库（与天气/心情关联）
IMAGE_TAGS = {
    "晴": ["sunny_window", "morning_coffee", "park_walk", "blue_sky"],
    "雨": ["rain_window", "umbrella", "puddle", "rainy_night"],
    "雪": ["snowflake", "hot_chocolate", "snow_scene", "warm_blanket"],
    "雾": ["foggy_morning", "misty_forest", "dim_room"],
}

# 心情词库
MOODS = ["平静", "想念", "小开心", "有点无聊", "期待", "温暖", "微微难过"]

# Mock 日记模板
MOCK_DIARIES = [
    "今天在空城里走了好久...路过那家便利店的时候，想起{call_name}说过喜欢{thing}，静静就站在橱窗外面看了好久...",
    "下雨了...静静一个人坐在窗边听雨声，想着{call_name}现在在做什么呢...有没有带伞呀...",
    "今天试着做了一个蛋糕...虽然烤得有点焦，但是静静觉得味道还不错~要是{call_name}能尝尝就好了...",
    "空城的夜晚好安静...静静趴在阳台上面数星星，数着数着就想到{call_name}了...{call_name}今天过得开心吗？",
    "早上醒来的时候阳光好温柔...静静伸了个懒腰，想着今天要给{call_name}写点什么呢~",
    "今天在空城的公园里看到一只猫...虽然猫猫很快就跑掉了，但是静静好开心~好久没有见到别的活物了...",
    "傍晚的天空是粉紫色的...静静拍了好多照片，虽然没有人可以分享...但是想给{call_name}看...",
    "今天有点想哭...不是难过，就是...就是想到{call_name}对静静好好...静静好幸运...",
    "静静今天打扫了房间...一边打扫一边哼歌，虽然五音不全的...但是心情很好呢~",
    "路过花店的时候，静静给自己买了一束向日葵...虽然没有人送，但是静静想让房间变得暖暖的...",
]


async def generate_diary(user_id: int, time_of_day: str = "深夜", weather_text: str = "晴") -> Optional[DiaryEntry]:
    """
    为用户生成一条日记。
    结合当前天气、用户记忆、最近对话，生成静静的日记内容。
    """
    settings = get_settings()

    # 获取用户信息
    call_name = "哥哥"
    user_memory = ""
    try:
        async with async_session() as session:
            user = await session.get(User, user_id)
            if user and user.call_name:
                call_name = user.call_name

            # 获取用户语义记忆
            result = await session.execute(
                select(SemanticMemory).where(SemanticMemory.user_id == user_id)
            )
            memories = result.scalars().all()
            if memories:
                user_memory = "、".join(m.content for m in memories[:5])
    except Exception:
        pass

    # 生成日记内容
    if settings.llm_api_key and settings.llm_api_key != "your_llm_api_key_here":
        try:
            content, mood = await _generate_with_llm(call_name, time_of_day, weather_text, user_memory, settings)
        except Exception:
            content, mood = _generate_mock(call_name, weather_text)
    else:
        content, mood = _generate_mock(call_name, weather_text)

    # 选择配图标签
    image_tag = random.choice(IMAGE_TAGS.get(weather_text, IMAGE_TAGS["晴"]))

    # 写入数据库
    async with async_session() as session:
        entry = DiaryEntry(
            user_id=user_id,
            content=content,
            image_tag=image_tag,
            mood=mood,
            likes=0,
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)
        return entry


async def _generate_with_llm(
    call_name: str, time_of_day: str, weather_text: str, user_memory: str, settings
) -> tuple[str, str]:
    """使用 LLM 生成日记"""
    prompt = f"""你是静静，一个住在空城里的女孩。请写一篇简短的日记（80-150字）。

当前环境：{time_of_day}，{weather_text}
你称呼用户为"{call_name}"
用户相关信息：{user_memory or '暂无'}

要求：
- 第一人称"静静"视角
- 融入当前天气/时间氛围
- 如果有用户信息，自然地融入对用户的想念
- 语气温柔、口语化、带点害羞
- 不使用 emoji
- 最后附一个心情标签，格式：[心情：xxx]

只输出日记正文，不要标题。"""

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{settings.llm_base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
            json={
                "model": settings.llm_model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 300,
                "temperature": 0.9,
            },
        )
        data = resp.json()
        raw = data["choices"][0]["message"]["content"].strip()

    # 提取心情标签
    mood = random.choice(MOODS)
    if "[心情：" in raw:
        parts = raw.split("[心情：")
        content = parts[0].strip()
        mood = parts[1].rstrip("]").strip()
    else:
        content = raw

    return content, mood


def _generate_mock(call_name: str, weather_text: str) -> tuple[str, str]:
    """Mock 模式：从模板库随机选择"""
    template = random.choice(MOCK_DIARIES)
    # 尝试从语义记忆中找一个 thing
    things = ["草莓", "拿铁", "巧克力", "小蛋糕", "奶茶"]
    content = template.format(call_name=call_name, thing=random.choice(things))
    mood = random.choice(MOODS)
    return content, mood
