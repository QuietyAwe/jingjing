"""记忆 API：语义记忆 CRUD + 情景记忆查询"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.semantic_memory import SemanticMemory
from services.memory_recall import recall_episodic_memories

router = APIRouter(prefix="/api/memory", tags=["memory"])


# ─── 语义记忆 ───

class SemanticMemoryCreate(BaseModel):
    user_id: int
    content: str
    category: str = "general"


class SemanticMemoryResponse(BaseModel):
    id: int
    user_id: int
    content: str
    category: str

    model_config = {"from_attributes": True}


@router.get("/semantic/{user_id}", response_model=list[SemanticMemoryResponse])
async def get_semantic_memories(user_id: int, db: AsyncSession = Depends(get_db)):
    """获取用户的所有语义记忆"""
    result = await db.execute(
        select(SemanticMemory).where(SemanticMemory.user_id == user_id)
    )
    return result.scalars().all()


@router.post("/semantic", response_model=SemanticMemoryResponse, status_code=201)
async def create_semantic_memory(body: SemanticMemoryCreate, db: AsyncSession = Depends(get_db)):
    """手动写入语义记忆"""
    mem = SemanticMemory(user_id=body.user_id, content=body.content, category=body.category)
    db.add(mem)
    await db.commit()
    await db.refresh(mem)
    return mem


@router.delete("/semantic/{memory_id}")
async def delete_semantic_memory(memory_id: int, db: AsyncSession = Depends(get_db)):
    """删除单条语义记忆"""
    result = await db.execute(delete(SemanticMemory).where(SemanticMemory.id == memory_id))
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"deleted": True}


# ─── 情景记忆 ───

@router.get("/episodic/{user_id}")
async def get_episodic_memories(user_id: int, query: str = ""):
    """根据查询文本召回相关情景记忆"""
    if not query:
        return {"memories": [], "query": query}
    memories = await recall_episodic_memories(user_id, query)
    return {"memories": memories, "query": query}
