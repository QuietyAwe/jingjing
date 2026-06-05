from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import String, DateTime, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class SemanticMemory(Base):
    """语义记忆：用户告诉静静的事实（偏好、习惯、经历等）"""
    __tablename__ = "semantic_memory"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(index=True)
    content: Mapped[str] = mapped_column(Text)  # 记忆内容，如"怕黑"
    category: Mapped[str] = mapped_column(String(50), default="general")  # 分类：preference, habit, emotion, fact
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
