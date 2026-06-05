from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # MySQL
    database_url: str = "mysql+aiomysql://root:root123@localhost:3306/jingjing"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Milvus
    milvus_host: str = "localhost"
    milvus_port: int = 19530

    # 和风天气
    qweather_api_key: str = ""
    qweather_api_host: str = "devapi.qweather.com"

    # LLM（后续 Phase 使用）
    llm_api_key: str = ""
    llm_base_url: str = "https://api.anthropic.com"
    llm_model: str = "claude-sonnet-4-20250514"

    # TTS
    minimax_api_key: str = ""

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
