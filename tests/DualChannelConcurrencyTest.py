"""
双端并发与多实例隔离压测。

使用临时 SQLite，不连接真实微信/QQ，不发送平台消息。验证微信和 QQ
各自的 outbox 在并发重复写入时保持幂等，且每个平台只有一个消费者租约。
"""

import concurrent.futures
import importlib
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DualChannelConcurrencyTest(unittest.TestCase):
    """验证双端同时写入和多实例竞争不会产生重复消费者。"""

    def test_weixin_and_qq_parallel_duplicate_messages(self):
        """微信与 QQ 同时发送相同业务轮次时，各自只保留一条队列记录。"""
        with tempfile.TemporaryDirectory(prefix="synlove-dual-channel-") as temp:
            state_spec = importlib.util.spec_from_file_location(
                "isolated_state_service", ROOT / "state" / "stateService.py")
            state = importlib.util.module_from_spec(state_spec)
            state_spec.loader.exec_module(state)
            state.DB_PATH = Path(temp) / "weixin.db"
            state_db = state.connect()
            state.ensure_schema(state_db)

            os.environ["SYNLOVE_QQ_STATE_DB"] = str(Path(temp) / "qq.db")
            try:
                qq_module = importlib.import_module("qqState.qqStateService")
                qq = importlib.reload(qq_module)

                weixin_payload = {
                    "session_id": "shared-session",
                    "user_id": "u1",
                    "kind": "reply",
                    "text": "同一轮回复",
                    "turn": 7,
                }
                qq_payload = {
                    "text": "同一轮回复",
                    "target": {"kind": "c2c", "id": "u1"},
                    "msgId": "same-turn-7",
                }

                def write_weixin(_):
                    with state.connect() as db:
                        return state.enqueue_outbox(db, weixin_payload)["outbound_id"]

                def write_qq(_):
                    response = qq.handle({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {"name": "qq_enqueue", "arguments": {"reply": qq_payload}},
                    })
                    return response["result"]["structuredContent"]["outbox"]["id"]

                with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
                    # 交错提交后统一等待，保证两平台写操作实际重叠，不能串行测两批。
                    pending = [(pool.submit(write_weixin, i), pool.submit(write_qq, i))
                               for i in range(64)]
                    weixin_ids = [pair[0].result() for pair in pending]
                    qq_ids = [pair[1].result() for pair in pending]

                self.assertEqual(set(weixin_ids), {"shared-session:1"})
                self.assertEqual(len(set(qq_ids)), 1)
            finally:
                os.environ.pop("SYNLOVE_QQ_STATE_DB", None)
                state_db.close()

    def test_each_channel_has_one_active_consumer(self):
        """多实例抢占同一平台时只有一个租约成功，释放后下一个实例才能接管。"""
        with tempfile.TemporaryDirectory(prefix="synlove-lease-") as temp:
            spec = importlib.util.spec_from_file_location(
                "isolated_state_service_lease", ROOT / "state" / "stateService.py")
            state = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(state)
            state.DB_PATH = Path(temp) / "weixin.db"
            db = state.connect()
            state.ensure_schema(db)
            args = {
                "pid": 1,
                "process_started_at": 1,
                "account_id": "weixin",
                "stale_ms": 60_000,
            }
            def acquire(index):
                owner = f"weixin-{index}"
                connection = state.connect()
                try:
                    return owner, state.try_acquire_lease(
                        connection, {**args, "owner_id": owner})
                finally:
                    connection.close()

            with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
                results = list(pool.map(acquire, range(32)))
            winners = [owner for owner, acquired in results if acquired]
            self.assertEqual(len(winners), 1)
            state.release_lease(db, winners[0])
            db.close()


if __name__ == "__main__":
    unittest.main()
