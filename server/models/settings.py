from __future__ import annotations

from typing import Optional

from sqlalchemy import String, Float, Boolean, Integer
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class UserSettings(Base):
    """用户设置"""
    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(unique=True, index=True)

    # 声音设置
    tts_volume: Mapped[float] = mapped_column(Float, default=0.8)  # 静静语音音量 0-1
    ambient_volume: Mapped[float] = mapped_column(Float, default=0.15)  # 环境底噪基准音量 0-1

    # 视效设置
    dark_mode: Mapped[str] = mapped_column(String(20), default="system")  # system/light/dark/sync
    dynamic_effects: Mapped[bool] = mapped_column(Boolean, default=True)  # 动态视效开关

    # 通讯频率
    care_mode: Mapped[str] = mapped_column(String(20), default="normal")  # clingy/normal/dnd
