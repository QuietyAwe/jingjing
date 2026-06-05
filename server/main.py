from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
import models.semantic_memory  # 确保表被创建
import models.settings  # 确保表被创建
import models.diary  # 确保表被创建
import models.diary_comment  # 确保表被创建
import models.care_event  # 确保表被创建
from redis_client import init_redis, close_redis
from milvus_client import init_milvus, close_milvus
from routes.user import router as user_router
from routes.weather import router as weather_router
from routes.chat import router as chat_router
from routes.memory import router as memory_router
from routes.settings import router as settings_router
from routes.diary import router as diary_router
from routes.voice import router as voice_router
from routes.sleep import router as sleep_router
from routes.care import router as care_router
from routes.vision import router as vision_router
from routes.timeline import router as timeline_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理：启动时初始化，关闭时清理"""
    # 启动
    await init_db()
    await init_redis()
    init_milvus()
    print("[OK] All services initialized")
    yield
    # 关闭
    await close_redis()
    close_milvus()
    print("[OK] All services closed")


app = FastAPI(
    title="晚安静静 API",
    description="与幽灵少女的跨时空通讯 —— 后端服务",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS（开发阶段允许所有来源，生产环境需收紧）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """健康检查接口"""
    return {"status": "ok"}


# 注册路由
app.include_router(user_router)
app.include_router(weather_router)
app.include_router(chat_router)
app.include_router(memory_router)
app.include_router(settings_router)
app.include_router(diary_router)
app.include_router(voice_router)
app.include_router(sleep_router)
app.include_router(care_router)
app.include_router(vision_router)
app.include_router(timeline_router)
