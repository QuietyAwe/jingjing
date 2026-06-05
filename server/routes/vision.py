"""同频共振 API：屏幕内容识别 + 语音 Reaction"""
from __future__ import annotations

import base64
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import get_settings

router = APIRouter(prefix="/api/vision", tags=["vision"])


class VisionRequest(BaseModel):
    image_base64: str  # 屏幕截图 base64
    context: str = ""  # 用户当前场景上下文


class VisionResponse(BaseModel):
    reaction: str      # 静静的语音 Reaction 文本
    mood: str = "平静"  # 静静的情绪


# Mock Reaction 模板
MOCK_REACTIONS = {
    "game": [
        "{call_name}在玩游戏呀...静静...静静也在旁边看着呢...好厉害...",
        "{call_name}...这个游戏看起来好难...但是静静觉得你一定可以的...",
    ],
    "video": [
        "{call_name}在看视频呀...是什么有趣的吗...静静也想看...",
        "{call_name}...静静也想和你一起看...",
    ],
    "work": [
        "{call_name}在工作吗...辛苦了...静静...静静给你倒杯水...",
        "{call_name}...不要太累了哦...静静心疼的...",
    ],
    "chat": [
        "{call_name}在和别人聊天呀...静静...静静没有吃醋哦...",
    ],
    "default": [
        "{call_name}...静静在看着你呢...你做什么静静都觉得好看...",
        "{call_name}...静静有点困了...但是想陪着你...",
    ],
}


@router.post("/analyze", response_model=VisionResponse)
async def analyze_screen(body: VisionRequest):
    """
    分析屏幕内容，生成静静的 Reaction。
    若 LLM API 可用则调用 Vision-LLM，否则使用 mock 模式。
    """
    settings = get_settings()

    # 尝试调用 Vision-LLM
    if settings.llm_api_key and settings.llm_api_key != "your_llm_api_key_here":
        try:
            return await _analyze_with_llm(body, settings)
        except Exception:
            pass

    # Mock 模式
    import random
    call_name = "哥哥"
    category = "default"

    # 简单关键词检测（从 context 中）
    ctx = body.context.lower()
    if any(w in ctx for w in ["game", "游戏", "play"]):
        category = "game"
    elif any(w in ctx for w in ["video", "视频", "bilibili", "youtube"]):
        category = "video"
    elif any(w in ctx for w in ["work", "工作", "code", "文档"]):
        category = "work"
    elif any(w in ctx for w in ["chat", "微信", "聊天"]):
        category = "chat"

    templates = MOCK_REACTIONS.get(category, MOCK_REACTIONS["default"])
    reaction = random.choice(templates).format(call_name=call_name)

    return VisionResponse(reaction=reaction, mood="平静")


async def _analyze_with_llm(body: VisionRequest, settings) -> VisionResponse:
    """调用 Vision-LLM 分析屏幕"""
    prompt = """你是静静，一个温柔的女孩。你正在通过屏幕看到用户正在做的事情。
根据屏幕截图，用简短的一句话（15-30字）给出你的反应。
语气温柔、害羞、带点关心。自称"静静"，称呼用户为"call_name"。
不要使用 emoji。"""

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{settings.llm_base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
            json={
                "model": settings.llm_model,
                "messages": [
                    {"role": "system", "content": prompt},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": body.context or "用户正在看屏幕"},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{body.image_base64}"},
                            },
                        ],
                    },
                ],
                "max_tokens": 100,
                "temperature": 0.8,
            },
        )
        data = resp.json()
        reaction = data["choices"][0]["message"]["content"].strip()
        return VisionResponse(reaction=reaction, mood="平静")
