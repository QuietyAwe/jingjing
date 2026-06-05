"""设置 API：用户设置 CRUD"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.settings import UserSettings

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    tts_volume: Optional[float] = None
    ambient_volume: Optional[float] = None
    dark_mode: Optional[str] = None  # system/light/dark/sync
    dynamic_effects: Optional[bool] = None
    care_mode: Optional[str] = None  # clingy/normal/dnd


class SettingsResponse(BaseModel):
    user_id: int
    tts_volume: float
    ambient_volume: float
    dark_mode: str
    dynamic_effects: bool
    care_mode: str

    model_config = {"from_attributes": True}


async def _get_or_create_settings(user_id: int, db: AsyncSession) -> UserSettings:
    """获取用户设置，不存在则创建默认设置"""
    result = await db.execute(select(UserSettings).where(UserSettings.user_id == user_id))
    settings = result.scalar_one_or_none()
    if not settings:
        settings = UserSettings(user_id=user_id)
        db.add(settings)
        await db.commit()
        await db.refresh(settings)
    return settings


@router.get("/{user_id}", response_model=SettingsResponse)
async def get_settings(user_id: int, db: AsyncSession = Depends(get_db)):
    """获取用户设置"""
    settings = await _get_or_create_settings(user_id, db)
    return settings


@router.put("/{user_id}", response_model=SettingsResponse)
async def update_settings(user_id: int, body: SettingsUpdate, db: AsyncSession = Depends(get_db)):
    """更新用户设置"""
    settings = await _get_or_create_settings(user_id, db)

    if body.tts_volume is not None:
        settings.tts_volume = max(0.0, min(1.0, body.tts_volume))
    if body.ambient_volume is not None:
        settings.ambient_volume = max(0.0, min(1.0, body.ambient_volume))
    if body.dark_mode is not None:
        if body.dark_mode not in ("system", "light", "dark", "sync"):
            raise HTTPException(status_code=400, detail="Invalid dark_mode value")
        settings.dark_mode = body.dark_mode
    if body.dynamic_effects is not None:
        settings.dynamic_effects = body.dynamic_effects
    if body.care_mode is not None:
        if body.care_mode not in ("clingy", "normal", "dnd"):
            raise HTTPException(status_code=400, detail="Invalid care_mode value")
        settings.care_mode = body.care_mode

    await db.commit()
    await db.refresh(settings)
    return settings


# ─── 记忆重置 ───

@router.post("/{user_id}/reset-memory")
async def reset_memory(user_id: int, mode: str = "soft", db: AsyncSession = Depends(get_db)):
    """
    记忆重置。
    mode=soft: 仅清除情景记忆（Milvus）
    mode=hard: 同时清除语义记忆（MySQL）+ 情景记忆（Milvus）+ Working Memory（Redis）
    """
    if mode not in ("soft", "hard"):
        raise HTTPException(status_code=400, detail="Mode must be 'soft' or 'hard'")

    from redis_client import clear_working_memory
    from milvus_client import get_collection
    from models.semantic_memory import SemanticMemory
    from sqlalchemy import delete

    # 软重置：清除 Milvus
    try:
        collection = get_collection()
        collection.delete(f"user_id == {user_id}")
    except Exception:
        pass

    if mode == "hard":
        # 硬重置：额外清除 MySQL 语义记忆 + Redis Working Memory
        await db.execute(delete(SemanticMemory).where(SemanticMemory.user_id == user_id))
        await db.commit()
        await clear_working_memory(user_id)

    return {"reset": mode, "user_id": user_id}
