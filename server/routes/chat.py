"""聊天 API：SSE 流式输出（含安全检查）"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.user import User
from services.llm_service import stream_chat
from services.safety import (
    detect_self_harm,
    append_crisis_info,
    detect_boundary_violation,
    get_boundary_response,
    check_abuse_circuit_breaker,
    is_user_in_silence,
)
from services.care_service import update_last_active

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatRequest(BaseModel):
    user_id: int
    content: str


@router.post("")
async def chat_endpoint(body: ChatRequest, db: AsyncSession = Depends(get_db)):
    """
    发送消息给静静，SSE 流式返回回复。
    响应格式：每行一个 JSON {"type": "token", "content": "..."}
    最后一行：{"type": "done"}
    """
    # 验证用户存在
    result = await db.execute(select(User).where(User.id == body.user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    call_name = "哥哥" if user.call_name == "gege" else (
        "姐姐" if user.call_name == "jiejie" else user.call_name
    )

    # ─── 安全检查 ───

    # 辱骂熔断
    is_blocked, abuse_response = await check_abuse_circuit_breaker(body.user_id, body.content)
    if is_blocked:
        if abuse_response:
            # 触发沉默期，发送统一回复
            async def abuse_stream():
                for char in abuse_response:
                    yield f"data: {json.dumps({'type': 'token', 'content': char}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return StreamingResponse(abuse_stream(), media_type="text/event-stream")
        else:
            # 在沉默期内，不回复
            async def silence_stream():
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return StreamingResponse(silence_stream(), media_type="text/event-stream")

    # 角色越界检测
    if detect_boundary_violation(body.content):
        boundary_resp = get_boundary_response(call_name)

        async def boundary_stream():
            for char in boundary_resp:
                yield f"data: {json.dumps({'type': 'token', 'content': char}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return StreamingResponse(boundary_stream(), media_type="text/event-stream")

    # 自伤检测标记
    is_crisis = detect_self_harm(body.content)

    # ─── 正常对话流程 ───

    # 更新用户最后活跃时间（用于主动关怀）
    await update_last_active(body.user_id)

    async def event_stream():
        try:
            async for token in stream_chat(body.user_id, call_name, body.content):
                yield f"data: {json.dumps({'type': 'token', 'content': token}, ensure_ascii=False)}\n\n"

            # 自伤检测：追加援助信息
            if is_crisis:
                for char in CRISIS_HOTLINE_MSG:
                    yield f"data: {json.dumps({'type': 'token', 'content': char}, ensure_ascii=False)}\n\n"

            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# 修复：自伤回复末尾的援助信息常量
CRISIS_HOTLINE_MSG = (
    "\n\n那个...静静不太懂这些...但是...有人说打这个电话会有人帮你...400-161-9995..."
    "静静...静静会一直在这里的..."
)
