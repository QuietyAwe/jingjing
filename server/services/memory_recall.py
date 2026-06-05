"""Memory-Recall：从 Milvus 中召回相关情景记忆"""
from __future__ import annotations

import math
from datetime import datetime

from milvus_client import get_collection
from services.embedding_service import get_embedding

# 混合打分权重
W_SIM = 0.5   # 向量相似度权重
W_DEC = 0.2   # 时间衰减权重
W_IMP = 0.3   # 重要性权重
LAMBDA = 0.01  # 衰减系数（约 70 天衰减至 50%）
TOP_K = 5      # 每次召回数量


async def recall_episodic_memories(user_id: int, query_text: str) -> list[dict]:
    """
    根据用户输入，从 Milvus 中召回最相关的情景记忆。
    使用混合打分公式：S = w_sim * Similarity + w_dec * Decay(t) + w_imp * Importance
    """
    # 向量化查询文本
    query_embedding = await get_embedding(query_text)

    # 在 Milvus 中检索
    collection = get_collection()
    results = collection.search(
        data=[query_embedding],
        anns_field="embedding",
        param={"metric_type": "COSINE", "params": {"nprobe": 16}},
        limit=TOP_K * 3,  # 多召回一些，后续用混合打分重排
        expr=f"user_id == {user_id} and status == 'active'",
        output_fields=["text_content", "timestamp", "importance_score", "status"],
    )

    if not results or not results[0]:
        return []

    # 混合打分重排
    now = datetime.now()
    scored = []
    for hit in results[0]:
        entity = hit.entity
        similarity = hit.score  # COSINE 相似度

        # 时间衰减
        try:
            mem_time = datetime.fromisoformat(entity.get("timestamp", now.isoformat()))
            days_diff = (now - mem_time).total_seconds() / 86400
            decay = math.exp(-LAMBDA * days_diff)
        except (ValueError, TypeError):
            decay = 0.5

        # 重要性（归一化到 0-1）
        importance = entity.get("importance_score", 5) / 10.0

        # 混合打分
        score = W_SIM * similarity + W_DEC * decay + W_IMP * importance

        scored.append({
            "text": entity.get("text_content", ""),
            "timestamp": entity.get("timestamp", ""),
            "importance": entity.get("importance_score", 5),
            "similarity": round(similarity, 3),
            "decay": round(decay, 3),
            "final_score": round(score, 3),
        })

    # 按最终得分排序，取 Top-K
    scored.sort(key=lambda x: x["final_score"], reverse=True)
    return scored[:TOP_K]
