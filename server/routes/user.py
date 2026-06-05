from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models.user import User
from schemas.user import UserCreate, UserUpdate, UserResponse

router = APIRouter(prefix="/api/users", tags=["users"])


@router.post("", response_model=UserResponse, status_code=201)
async def create_user(body: UserCreate, db: AsyncSession = Depends(get_db)):
    """创建匿名用户（Onboarding 阶段）"""
    # 检查 device_uuid 是否已存在
    result = await db.execute(select(User).where(User.device_uuid == body.device_uuid))
    existing = result.scalar_one_or_none()
    if existing:
        return existing

    user = User(device_uuid=body.device_uuid, call_name=body.call_name)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: int, db: AsyncSession = Depends(get_db)):
    """获取用户信息"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(user_id: int, body: UserUpdate, db: AsyncSession = Depends(get_db)):
    """更新用户信息（身份锚定后更新 call_name 等）"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if body.call_name is not None:
        user.call_name = body.call_name
    if body.city is not None:
        user.city = body.city
    if body.phone is not None:
        user.phone = body.phone

    await db.commit()
    await db.refresh(user)
    return user
