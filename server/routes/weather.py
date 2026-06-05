from __future__ import annotations

from fastapi import APIRouter, Query

from weather import get_weather, get_weather_sync

router = APIRouter(prefix="/api/weather", tags=["weather"])


@router.get("")
async def get_weather_api(
    lat: float = Query(default=0.0, description="纬度"),
    lon: float = Query(default=0.0, description="经度"),
):
    """
    获取天气数据。
    降级链：GPS → IP → 默认值（深夜+晴）
    """
    if lat == 0.0 and lon == 0.0:
        # 无定位信息，使用同步兜底
        return get_weather_sync()
    return await get_weather(lat, lon)
