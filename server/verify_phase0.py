"""Phase 0 end-to-end verification script"""
import asyncio
import sys

from database import init_db, async_session
from models.user import User
from redis_client import init_redis, close_redis, push_message, get_recent_messages, clear_working_memory
from milvus_client import init_milvus, close_milvus, get_collection, COLLECTION_NAME
from weather import get_weather_sync
from sqlalchemy import select, text


async def verify_t001():
    """T-001: FastAPI health check"""
    print("=== T-001: FastAPI Skeleton ===")
    from main import app
    print(f"  App title: {app.title}")
    print(f"  Routes: {[r.path for r in app.routes if hasattr(r, 'path')]}")
    print(f"  Lifespan: {app.router.lifespan_context is not None}")
    print("  PASS")
    return True


async def verify_t002():
    """T-002: MySQL + User table"""
    print("\n=== T-002: MySQL + User Table ===")
    await init_db()

    async with async_session() as session:
        # Check table exists
        result = await session.execute(text("SHOW TABLES"))
        tables = [r[0] for r in result.fetchall()]
        print(f"  Tables: {tables}")
        assert "users" in tables, "users table not found"

        # Insert test user
        user = User(device_uuid="test-uuid-001", call_name="jiejie", city="Shanghai")
        session.add(user)
        await session.commit()
        print(f"  Inserted user: id={user.id}, call_name={user.call_name}")

        # Read back
        result = await session.execute(select(User).where(User.device_uuid == "test-uuid-001"))
        u = result.scalar_one()
        assert u.call_name == "jiejie"
        assert u.city == "Shanghai"
        print(f"  Read back: id={u.id}, call_name={u.call_name}, city={u.city}")

        # Cleanup
        await session.delete(u)
        await session.commit()
        print("  Cleanup done")

    print("  PASS")
    return True


async def verify_t003():
    """T-003: Redis Working Memory"""
    print("\n=== T-003: Redis Working Memory ===")
    await init_redis()

    uid = 999
    await clear_working_memory(uid)

    # Push 20 messages
    for i in range(20):
        await push_message(uid, "user", f"message {i}")
    print(f"  Pushed 20 messages")

    # Should return exactly 15
    msgs = await get_recent_messages(uid)
    assert len(msgs) == 15, f"Expected 15, got {len(msgs)}"
    assert msgs[0]["content"] == "message 5", f"First should be message 5, got {msgs[0]['content']}"
    assert msgs[-1]["content"] == "message 19", f"Last should be message 19, got {msgs[-1]['content']}"
    print(f"  Got {len(msgs)} messages (expected 15)")
    print(f"  Range: '{msgs[0]['content']}' -> '{msgs[-1]['content']}'")

    await clear_working_memory(uid)
    await close_redis()
    print("  Cleanup done")
    print("  PASS")
    return True


async def verify_t004():
    """T-004: Milvus collection"""
    print("\n=== T-004: Milvus Collection ===")
    init_milvus()

    from pymilvus import utility
    exists = utility.has_collection(COLLECTION_NAME)
    print(f"  Collection '{COLLECTION_NAME}' exists: {exists}")
    assert exists

    col = get_collection()
    fields = [f.name for f in col.schema.fields]
    print(f"  Fields: {fields}")
    assert "user_id" in fields
    assert "embedding" in fields
    assert "importance_score" in fields

    close_milvus()
    print("  PASS")
    return True


async def verify_t005():
    """T-005: Weather fallback"""
    print("\n=== T-005: Weather Fallback ===")
    result = get_weather_sync()
    print(f"  Result: {result}")
    assert "time_of_day" in result
    assert "weather_text" in result
    assert result["time_of_day"] in ["qingchen", "wuhou", "bangwan", "shenye", "清晨", "午后", "傍晚", "深夜"]
    print("  PASS")
    return True


async def main():
    print("Phase 0 End-to-End Verification")
    print("=" * 40)

    results = []
    for name, test in [
        ("T-001", verify_t001),
        ("T-002", verify_t002),
        ("T-003", verify_t003),
        ("T-004", verify_t004),
        ("T-005", verify_t005),
    ]:
        try:
            ok = await test()
            results.append((name, ok))
        except Exception as e:
            print(f"  FAIL: {e}")
            results.append((name, False))

    print("\n" + "=" * 40)
    print("Results:")
    for name, ok in results:
        status = "PASS" if ok else "FAIL"
        print(f"  {name}: {status}")

    all_pass = all(ok for _, ok in results)
    print(f"\nOverall: {'ALL PASS' if all_pass else 'SOME FAILED'}")
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
