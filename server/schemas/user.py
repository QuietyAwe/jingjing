from __future__ import annotations

from typing import Optional
from pydantic import BaseModel
from datetime import datetime


class UserCreate(BaseModel):
    """创建匿名用户"""
    device_uuid: str
    call_name: str = "gege"


class UserUpdate(BaseModel):
    """更新用户信息"""
    call_name: Optional[str] = None
    city: Optional[str] = None
    phone: Optional[str] = None


class UserResponse(BaseModel):
    """用户信息响应"""
    id: int
    device_uuid: str
    call_name: str
    city: Optional[str] = None
    phone: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
