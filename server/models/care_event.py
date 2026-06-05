"""关怀事件 ORM 模型"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey

from database import Base


class CareEvent(Base):
    """记录已发送的关怀事件，避免重复推送"""
    __tablename__ = "care_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    event_type = Column(String(50), nullable=False)  # daily_care, special_event
    trigger = Column(String(100), nullable=False)     # 触发条件描述
    message = Column(Text, nullable=False)            # 推送文案
    sent_at = Column(DateTime, default=datetime.utcnow)
