"""技能复盘素材链路测试；使用临时会话库，不读取私人记录、不调用模型。注册参数：无。"""
import json
import sys
import tempfile
import time
import unittest
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from skills.review.transcriptBuilder import encode_project_token, find_session_root, transcriptBuilder
from skills.config.configLoader import skillReviewConfig
from skills.skillReviewService import run_once


class SkillTranscriptTests(unittest.TestCase):
    """验证路径协议、跨工程隔离、真实压缩会话及复盘入口的水位保护。"""

    def test_project_key_matches_harness(self):
        """完整 Windows 路径包含连字符、中文、标点和代理对时，与 Harness 编码逐字一致。"""
        self.assertEqual(encode_project_token("G:\\桌面\\SynLove-Personal-Agent"),
                         "--G-~684C~9762-SynLove-Personal-Agent--")
        self.assertEqual(encode_project_token("C:\\a b\\x😀"), "--C-a~0020b-x~D83D~DE00--")

    def test_exact_project_isolation(self):
        """同名工程在不同目录时只读取精确完整路径，不串用其他安装的记录。"""
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            wanted = home / "one" / "SynLove-Personal-Agent"
            other = home / "two" / "SynLove-Personal-Agent"
            other_root = home / encode_project_token(other.resolve())
            other_root.mkdir()
            self.assertIsNone(find_session_root(home, wanted))
            exact = home / encode_project_token(wanted.resolve())
            exact.mkdir()
            self.assertEqual(find_session_root(home, wanted), exact)

    def test_review_entry_reads_real_compressed_session(self):
        """人工会话经真实解压和复盘入口；模拟模型结束后推进水位，不发送消息。"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "runtime" / "dsh"
            session = data / "sessions" / encode_project_token(root.resolve()) / "main"
            session.mkdir(parents=True)
            stamp = int(time.time() * 1000) - 1000
            record = {"time": stamp, "type": "user/message",
                      "data": {"content": [{"type": "text", "text": "人工验收素材"}]}}
            raw = (json.dumps(record) + "\n").encode()
            compressed = subprocess.check_output(
                [shutil.which("node"), "-e", "const z=require('node:zlib');process.stdout.write(z.zstdCompressSync(Buffer.from('{\"type\":\"session\"}\\n')));process.stdout.write(z.zstdCompressSync(require('node:fs').readFileSync(0)))"],
                input=raw, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            (session / "session.v3.jsonl.zstd").write_bytes(compressed)
            cfg = skillReviewConfig(root)
            with patch("skills.skillReviewService.ROOT", root), patch.dict(
                    "os.environ", {"DSH_HOME": str(data)}), patch(
                    "skills.skillReviewService.skillReviewer") as reviewer:
                reviewer.return_value.review.return_value = {"saved": [], "staged": [], "summary": "Nothing to save."}
                result = run_once(cfg, notify=False)
                self.assertTrue(result["ok"])
                transcript = reviewer.return_value.review.call_args.args[0]
                self.assertEqual(transcript["turns"], 1)
                self.assertIn("人工验收素材", transcript["text"])
                state = json.loads(Path(cfg.get("stateFile")).read_text(encoding="utf-8"))
                self.assertGreaterEqual(state["last_review_ts"], stamp)
            (session / "session.v3.jsonl.zstd").write_bytes(b"broken")
            with self.assertRaises(RuntimeError):
                transcriptBuilder(session.parent).build(0, stamp + 5000)
            self.assertEqual(json.loads(Path(cfg.get("stateFile")).read_text(encoding="utf-8")),
                             state)
