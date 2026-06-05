"""Memory-Extractor：从对话中提取事实和事件片段"""
from __future__ import annotations

import json
from datetime import datetime

import httpx

from config import get_settings
from database import async_session
from models.semantic_memory import SemanticMemory
from services.embedding_service import get_embedding
from milvus_client import get_collection


async def extract_and_store_semantic(user_id: int, conversation: list[dict]) -> list[str]:
    """
    从对话中提取语义记忆（用户事实/偏好），写入 MySQL。
    返回提取的记忆列表。
    """
    settings = get_settings()

    if settings.llm_api_key and settings.llm_api_key != "your_llm_api_key_here":
        try:
            facts = await _extract_with_llm(conversation, settings)
        except Exception:
            facts = _extract_with_rules(conversation)
    else:
        facts = _extract_with_rules(conversation)

    # 写入数据库
    stored = []
    async with async_session() as session:
        for fact in facts:
            mem = SemanticMemory(user_id=user_id, content=fact["content"], category=fact["category"])
            session.add(mem)
            stored.append(fact["content"])
        await session.commit()

    return stored


async def extract_and_store_episodic(user_id: int, conversation: list[dict]) -> None:
    """
    从对话中提取情景记忆片段，向量化后写入 Milvus。
    """
    if not conversation:
        return

    # 合并对话为一个文本片段
    text_parts = []
    for msg in conversation[-10:]:  # 最近 10 轮
        role = "用户" if msg["role"] == "user" else "静静"
        text_parts.append(f"{role}：{msg['content']}")
    text = "\n".join(text_parts)

    # 计算重要性打分
    importance = _score_importance(text)

    # 向量化
    embedding = await get_embedding(text)

    # 写入 Milvus
    collection = get_collection()
    collection.insert([
        [user_id],           # user_id
        [text[:2000]],       # text_content (截断)
        [embedding],         # embedding
        [datetime.now().isoformat()],  # timestamp
        [importance],        # importance_score
        ["active"],          # status
    ])


async def _extract_with_llm(conversation: list[dict], settings) -> list[dict]:
    """使用 LLM 提取事实"""
    conv_text = "\n".join(
        f"{'用户' if m['role'] == 'user' else '静静'}：{m['content']}"
        for m in conversation[-10:]
    )

    prompt = f"""分析以下对话，提取用户告诉静静的事实、偏好、习惯、经历。
只提取明确提到的信息，不要推测。
输出 JSON 数组，每个元素 {{"content": "事实描述", "category": "preference|habit|emotion|fact"}}
如果没有可提取的事实，返回空数组 []

对话：
{conv_text}"""

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{settings.llm_base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
            json={
                "model": settings.llm_model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 300,
                "temperature": 0.1,
            },
        )
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        # 尝试解析 JSON
        try:
            # 处理可能的 markdown 代码块
            if "```" in content:
                content = content.split("```")[1]
                if content.startswith("json"):
                    content = content[4:]
            return json.loads(content.strip())
        except (json.JSONDecodeError, IndexError):
            return []


def _extract_with_rules(conversation: list[dict]) -> list[dict]:
    """基于规则的事实提取（mock 模式）"""
    facts = []
    for msg in conversation:
        if msg["role"] != "user":
            continue
        content = msg["content"]

        # 情感关键词
        emotion_keywords = {
            "怕黑": ("怕黑", "emotion"),
            "害怕": ("容易害怕", "emotion"),
            "喜欢": ("有喜欢的事物", "preference"),
            "讨厌": ("有讨厌的事物", "preference"),
            "加班": ("经常加班", "habit"),
            "熬夜": ("习惯熬夜", "habit"),
            "失眠": ("有失眠困扰", "habit"),
        }

        for keyword, (fact, category) in emotion_keywords.items():
            if keyword in content:
                # 去重检查（简单匹配）
                if not any(fact in f["content"] for f in facts):
                    facts.append({"content": content[:100], "category": category})

    return facts[:5]  # 最多提取 5 条


def _score_importance(text: str) -> int:
    """基于关键词的重要性打分（1-10）"""
    high_score_keywords = ["怕", "害怕", "恐惧", "爱", "喜欢", "讨厌", "小时候", "父母", "家", "孤独", "哭"]
    medium_score_keywords = ["加班", "工作", "累", "开心", "难过", "生气"]
    low_score_keywords = ["吃", "喝", "天气", "今天"]

    score = 3  # 基础分

    for kw in high_score_keywords:
        if kw in text:
            score += 2
    for kw in medium_score_keywords:
        if kw in text:
            score += 1
    for kw in low_score_keywords:
        if kw in text:
            score -= 0.5

    return max(1, min(10, int(score)))
