"""Embedding 服务：文本向量化"""
from __future__ import annotations

import hashlib
import struct

import httpx

from config import get_settings

EMBEDDING_DIM = 1536  # OpenAI text-embedding-3-small


async def get_embedding(text: str) -> list[float]:
    """
    将文本转换为向量。
    若 API Key 可用，调用 OpenAI Embedding API；
    否则使用 mock 模式生成确定性向量（基于文本哈希）。
    """
    settings = get_settings()

    if settings.llm_api_key and settings.llm_api_key != "your_llm_api_key_here":
        try:
            return await _call_openai_embedding(text, settings)
        except Exception:
            pass

    return _mock_embedding(text)


async def _call_openai_embedding(text: str, settings) -> list[float]:
    """调用 OpenAI Embedding API"""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{settings.llm_base_url}/v1/embeddings",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
            json={"model": "text-embedding-3-small", "input": text},
        )
        data = resp.json()
        return data["data"][0]["embedding"]


def _mock_embedding(text: str) -> list[float]:
    """
    Mock 模式：基于文本哈希生成确定性向量。
    相同文本 → 相同向量，不同文本 → 不同向量。
    """
    # 使用 SHA256 生成确定性哈希
    hash_bytes = hashlib.sha256(text.encode("utf-8")).digest()

    # 扩展到 1536 维（1536 * 4 bytes = 6144 bytes）
    expanded = b""
    for i in range(EMBEDDING_DIM * 4 // len(hash_bytes) + 1):
        expanded += hashlib.sha256(hash_bytes + i.to_bytes(4, "big")).digest()
    expanded = expanded[: EMBEDDING_DIM * 4]

    # 转为 float 列表并归一化
    floats = [struct.unpack("f", expanded[i * 4 : i * 4 + 4])[0] for i in range(EMBEDDING_DIM)]
    norm = sum(x * x for x in floats) ** 0.5
    if norm > 0:
        floats = [x / norm for x in floats]

    return floats
