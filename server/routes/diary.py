"""镜像日记 API"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.diary import DiaryEntry
from models.diary_comment import DiaryComment
from services.diary_generator import generate_diary
from services.memory_extractor import extract_and_store_episodic

router = APIRouter(prefix="/api/diary", tags=["diary"])


# ---------- Schemas ----------

class DiaryOut(BaseModel):
    id: int
    user_id: int
    content: str
    image_tag: Optional[str] = None
    mood: Optional[str] = None
    likes: int = 0
    comment_count: int = 0
    created_at: str

    class Config:
        from_attributes = True


class CommentIn(BaseModel):
    content: str


class CommentOut(BaseModel):
    id: int
    diary_id: int
    user_id: int
    content: str
    created_at: str

    class Config:
        from_attributes = True


# ---------- Routes ----------

@router.get("/{user_id}", response_model=list[DiaryOut])
async def list_diaries(
    user_id: int,
    page: int = Query(1, ge=1),
    size: int = Query(10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
):
    """获取日记列表（分页，倒序）"""
    offset = (page - 1) * size
    result = await db.execute(
        select(DiaryEntry)
        .where(DiaryEntry.user_id == user_id)
        .order_by(desc(DiaryEntry.created_at))
        .offset(offset)
        .limit(size)
    )
    entries = result.scalars().all()

    # 批量查询评论数
    diary_ids = [e.id for e in entries]
    comment_counts = {}
    if diary_ids:
        count_result = await db.execute(
            select(DiaryComment.diary_id, func.count(DiaryComment.id))
            .where(DiaryComment.diary_id.in_(diary_ids))
            .group_by(DiaryComment.diary_id)
        )
        comment_counts = {row[0]: row[1] for row in count_result.all()}

    return [
        DiaryOut(
            id=e.id,
            user_id=e.user_id,
            content=e.content,
            image_tag=e.image_tag,
            mood=e.mood,
            likes=e.likes,
            comment_count=comment_counts.get(e.id, 0),
            created_at=e.created_at.isoformat(),
        )
        for e in entries
    ]


@router.post("/{user_id}/generate", response_model=DiaryOut)
async def generate_new_diary(
    user_id: int,
    time_of_day: str = Query("深夜"),
    weather_text: str = Query("晴"),
    db: AsyncSession = Depends(get_db),
):
    """手动生成一条日记（也可由定时任务调用）"""
    entry = await generate_diary(user_id, time_of_day, weather_text)
    if not entry:
        raise HTTPException(status_code=500, detail="日记生成失败")
    return DiaryOut(
        id=entry.id,
        user_id=entry.user_id,
        content=entry.content,
        image_tag=entry.image_tag,
        mood=entry.mood,
        likes=entry.likes,
        comment_count=0,
        created_at=entry.created_at.isoformat(),
    )


@router.post("/{diary_id}/like")
async def like_diary(diary_id: int, db: AsyncSession = Depends(get_db)):
    """点赞日记"""
    entry = await db.get(DiaryEntry, diary_id)
    if not entry:
        raise HTTPException(status_code=404, detail="日记不存在")
    entry.likes = (entry.likes or 0) + 1
    await db.commit()
    return {"likes": entry.likes}


@router.post("/{diary_id}/comment", response_model=CommentOut)
async def add_comment(
    diary_id: int,
    body: CommentIn,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """添加评论"""
    entry = await db.get(DiaryEntry, diary_id)
    if not entry:
        raise HTTPException(status_code=404, detail="日记不存在")

    comment = DiaryComment(
        diary_id=diary_id,
        user_id=user_id,
        content=body.content,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)

    # 评论异步写入情景记忆（不阻塞响应）
    try:
        await extract_and_store_episodic(
            user_id,
            [{"role": "user", "content": f"评论了静静的日记：{body.content}"}],
        )
    except Exception:
        pass

    return CommentOut(
        id=comment.id,
        diary_id=comment.diary_id,
        user_id=comment.user_id,
        content=comment.content,
        created_at=comment.created_at.isoformat(),
    )


@router.get("/{diary_id}/comments", response_model=list[CommentOut])
async def list_comments(
    diary_id: int,
    db: AsyncSession = Depends(get_db),
):
    """获取日记评论列表"""
    result = await db.execute(
        select(DiaryComment)
        .where(DiaryComment.diary_id == diary_id)
        .order_by(DiaryComment.created_at)
    )
    comments = result.scalars().all()
    return [
        CommentOut(
            id=c.id,
            diary_id=c.diary_id,
            user_id=c.user_id,
            content=c.content,
            created_at=c.created_at.isoformat(),
        )
        for c in comments
    ]
