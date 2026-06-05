from pymilvus import (
    connections,
    Collection,
    CollectionSchema,
    FieldSchema,
    DataType,
    utility,
)

from config import get_settings

COLLECTION_NAME = "episodic_memory"
EMBEDDING_DIM = 1536  # OpenAI text-embedding-3-small


def init_milvus():
    """初始化 Milvus 连接并确保集合存在"""
    settings = get_settings()
    connections.connect(
        alias="default",
        host=settings.milvus_host,
        port=settings.milvus_port,
    )
    _ensure_collection()


def close_milvus():
    """关闭 Milvus 连接"""
    connections.disconnect("default")


def _ensure_collection():
    """确保 episodic_memory 集合存在，不存在则创建"""
    if utility.has_collection(COLLECTION_NAME):
        return

    fields = [
        FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
        FieldSchema(name="user_id", dtype=DataType.INT64),
        FieldSchema(name="text_content", dtype=DataType.VARCHAR, max_length=2000),
        FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
        FieldSchema(name="timestamp", dtype=DataType.VARCHAR, max_length=30),
        FieldSchema(name="importance_score", dtype=DataType.INT64),
        FieldSchema(name="status", dtype=DataType.VARCHAR, max_length=20),
    ]

    schema = CollectionSchema(fields=fields, description="静静的情景记忆向量库")
    collection = Collection(name=COLLECTION_NAME, schema=schema)

    # 创建向量索引（IVF_FLAT，适合中小规模数据）
    index_params = {
        "metric_type": "COSINE",
        "index_type": "IVF_FLAT",
        "params": {"nlist": 128},
    }
    collection.create_index(field_name="embedding", index_params=index_params)


def get_collection() -> Collection:
    """获取 episodic_memory 集合实例"""
    collection = Collection(COLLECTION_NAME)
    collection.load()
    return collection
