"""日记评论 ORM 模型"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, Integer, Text, DateTime, ForeignKey

from database import Base


class DiaryComment(Base):
    __tablename__ = "diary_comments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    diary_id = Column(Integer, ForeignKey("diary_entries.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
