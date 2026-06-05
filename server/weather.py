from __future__ import annotations

from datetime import datetime

import httpx

from config import get_settings

# 天气缓存（简单内存缓存，后续可升级为 Redis 缓存）
_weather_cache: dict[str, dict] = {}
_CACHE_TTL_SECONDS = 7200  # 2 小时


def _get_time_of_day(hour: int | None = None) -> str:
    """根据小时判断时间段"""
    h = hour if hour is not None else datetime.now().hour
    if 6 <= h < 12:
        return "清晨"
    elif 12 <= h < 17:
        return "午后"
    elif 17 <= h < 21:
        return "傍晚"
    else:
        return "深夜"


def _map_weather_text(text: str) -> str:
    """将和风天气的详细描述映射为四分类"""
    rain_keywords = ["雨", "雷", "阵雨", "暴雨", "小雨", "中雨", "大雨", "毛毛雨"]
    snow_keywords = ["雪", "霜", "冰"]
    fog_keywords = ["雾", "霾", "沙尘", "浮尘"]

    for kw in rain_keywords:
        if kw in text:
            return "雨"
    for kw in snow_keywords:
        if kw in text:
            return "雪"
    for kw in fog_keywords:
        if kw in text:
            return "雾"
    return "晴"


async def get_weather(lat: float, lon: float) -> dict:
    """
    获取天气数据，返回 {"time_of_day": "...", "weather_text": "..."}
    降级链：API → 缓存 → 默认值
    """
    settings = get_settings()
    cache_key = f"{lat:.2f},{lon:.2f}"

    # 1. 尝试调用和风天气 API
    if settings.qweather_api_key:
        try:
            result = await _fetch_qweather(lat, lon, settings)
            if result:
                _weather_cache[cache_key] = {
                    "data": result,
                    "ts": datetime.now().timestamp(),
                }
                return result
        except Exception:
            pass  # 降级到缓存

    # 2. 尝试缓存
    cached = _weather_cache.get(cache_key)
    if cached and (datetime.now().timestamp() - cached["ts"]) < _CACHE_TTL_SECONDS:
        return cached["data"]

    # 3. 兜底默认值
    return {"time_of_day": "深夜", "weather_text": "晴"}


async def _fetch_qweather(lat: float, lon: float, settings) -> dict | None:
    """调用和风天气实时天气接口"""
    location = f"{lon:.2f},{lat:.2f}"
    url = f"https://{settings.qweather_api_host}/v7/weather/now"
    params = {"location": location, "key": settings.qweather_api_key}

    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(url, params=params)
        data = resp.json()

    if data.get("code") != "200":
        return None

    now = data.get("now", {})
    weather_desc = now.get("text", "晴")
    return {
        "time_of_day": _get_time_of_day(),
        "weather_text": _map_weather_text(weather_desc),
    }


def get_weather_sync() -> dict:
    """同步版本（不需要 API key，仅基于本地时间和默认值）"""
    return {"time_of_day": _get_time_of_day(), "weather_text": "晴"}
