"""主动关怀 API：定时检查触发条件"""
from __future__ import annotations

from typing import Dict, List

from fastapi import APIRouter, Query
from pydantic import BaseModel

from services.care_service import check_daily_care, check_special_events, update_last_active

router = APIRouter(prefix="/api/care", tags=["care"])


class CareCheckResult(BaseModel):
    daily_care: List[Dict]
    special_events: List[Dict]
    total: int


@router.get("/check", response_model=CareCheckResult)
async def run_care_check():
    """
    执行关怀检查（由定时任务或手动调用）。
    返回需要推送的关怀消息列表。
    实际推送由前端 Push Notification 处理。
    """
    daily = await check_daily_care()
    special = await check_special_events()
    return CareCheckResult(
        daily_care=daily,
        special_events=special,
        total=len(daily) + len(special),
    )


@router.post("/active/{user_id}")
async def mark_user_active(user_id: int):
    """标记用户为活跃（聊天时调用）"""
    await update_last_active(user_id)
    return {"status": "ok"}
