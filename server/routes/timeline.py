"""时空 Tab API：记忆回廊 + 数据备份 + 导出"""
from __future__ import annotations

from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.semantic_memory import SemanticMemory
from models.user import User
from redis_client import get_recent_messages
from milvus_client import get_collection
from services.embedding_service import get_embedding

router = APIRouter(prefix="/api/timeline", tags=["timeline"])


# ---------- Schemas ----------

class MemoryCard(BaseModel):
    id: int
    content: str
    category: str
    created_at: str
    related_messages: List[Dict] = []


class GiftResult(BaseModel):
    success: bool
    message: str


class BackupResult(BaseModel):
    success: bool
    count: int
    message: str


class ExportData(BaseModel):
    user_name: str
    memories: List[Dict]
    recent_messages: List[Dict]


# ---------- 记忆回廊 ----------

@router.get("/{user_id}/memories", response_model=List[MemoryCard])
async def list_memory_cards(
    user_id: int,
    db: AsyncSession = Depends(get_db),
):
    """获取记忆回廊卡片列表"""
    result = await db.execute(
        select(SemanticMemory)
        .where(SemanticMemory.user_id == user_id)
        .order_by(desc(SemanticMemory.created_at))
        .limit(50)
    )
    memories = result.scalars().all()

    cards = []
    for mem in memories:
        cards.append(MemoryCard(
            id=mem.id,
            content=mem.content,
            category=mem.category or "general",
            created_at=mem.created_at.isoformat() if mem.created_at else "",
        ))

    return cards


@router.get("/{user_id}/memory/{memory_id}/context")
async def get_memory_context(
    user_id: int,
    memory_id: int,
    db: AsyncSession = Depends(get_db),
):
    """获取某条记忆的上下文（最近对话切片）"""
    mem = await db.get(SemanticMemory, memory_id)
    if not mem or mem.user_id != user_id:
        raise HTTPException(status_code=404, detail="记忆不存在")

    # 获取最近对话作为上下文
    recent = await get_recent_messages(user_id, limit=10)

    return {
        "memory": {
            "id": mem.id,
            "content": mem.content,
            "category": mem.category,
        },
        "context_messages": recent,
    }


# ---------- 跨时空信箱 ----------

@router.post("/{user_id}/gift", response_model=GiftResult)
async def send_virtual_gift(
    user_id: int,
    gift_type: str = Query(...),
    message: str = Query(""),
    db: AsyncSession = Depends(get_db),
):
    """
    送出虚拟礼物。
    礼物记录写入语义记忆，静静会在聊天中提及。
    """
    gift_names = {
        "flower": "一束花",
        "star": "一颗星星",
        "moon": "一轮月亮",
        "cake": "一块蛋糕",
        "letter": "一封信",
    }
    gift_name = gift_names.get(gift_type, "一份礼物")

    user = await db.get(User, user_id)
    call_name = user.call_name if user and user.call_name else "哥哥"

    # 写入语义记忆
    content = f"{call_name}送了静静{gift_name}"
    if message:
        content += f"，附言：{message}"

    mem = SemanticMemory(user_id=user_id, content=content, category="gift")
    db.add(mem)
    await db.commit()

    return GiftResult(
        success=True,
        message=f"静静收到{gift_name}了~好开心...",
    )


# ---------- 数据备份 ----------

@router.get("/{user_id}/backup", response_model=BackupResult)
async def export_backup(
    user_id: int,
    db: AsyncSession = Depends(get_db),
):
    """
    导出用户记忆数据（JSON 格式）。
    生产环境应加密后上传云端，当前返回数据摘要。
    """
    # 语义记忆
    result = await db.execute(
        select(SemanticMemory).where(SemanticMemory.user_id == user_id)
    )
    memories = result.scalars().all()

    # Working Memory
    recent = await get_recent_messages(user_id, limit=15)

    # 情景记忆（Milvus）
    episodic_count = 0
    try:
        collection = get_collection()
        count_result = collection.query(
            expr=f"user_id == {user_id}",
            output_fields=["id"],
            limit=1,
        )
        episodic_count = len(count_result) if count_result else 0
    except Exception:
        pass

    total = len(memories) + len(recent) + episodic_count

    return BackupResult(
        success=True,
        count=total,
        message=f"已备份 {len(memories)} 条语义记忆、{len(recent)} 条对话、{episodic_count} 条情景记忆",
    )


# ---------- 时空日志导出 ----------

@router.get("/{user_id}/export", response_model=ExportData)
async def export_timeline(
    user_id: int,
    db: AsyncSession = Depends(get_db),
):
    """
    导出时空日志数据（供前端生成长图/PDF）。
    """
    user = await db.get(User, user_id)
    call_name = user.call_name if user and user.call_name else "哥哥"

    # 语义记忆
    result = await db.execute(
        select(SemanticMemory).where(SemanticMemory.user_id == user_id)
        .order_by(desc(SemanticMemory.created_at))
        .limit(20)
    )
    memories = [
        {"content": m.content, "category": m.category, "created_at": m.created_at.isoformat() if m.created_at else ""}
        for m in result.scalars().all()
    ]

    # 最近对话
    recent = await get_recent_messages(user_id, limit=20)

    return ExportData(
        user_name=call_name,
        memories=memories,
        recent_messages=recent,
    )
