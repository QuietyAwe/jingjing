"""镜像日记 ORM 模型"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey

from database import Base


class DiaryEntry(Base):
    __tablename__ = "diary_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    content = Column(Text, nullable=False)           # 日记正文
    image_tag = Column(String(50), nullable=True)    # 配图标签（匹配素材库）
    mood = Column(String(20), nullable=True)         # 心情标签
    likes = Column(Integer, default=0)               # 点赞数
    created_at = Column(DateTime, default=datetime.utcnow)
