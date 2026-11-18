"""技能复盘游标测试：输入假记录，验证按顺序覆盖、并列时间戳与不足轮次的行为，不调用模型。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from skills.review.transcriptBuilder import transcriptBuilder
from skills.skillReviewService import append_unique


class SkillCursorTests(unittest.TestCase):
    """保证截断窗口不会永久遗失早期素材。"""

    def test_review_batch_results_are_unique(self):
        """跨批次聚合复盘结果时，同名技能只保留第一次出现的位置。"""
        found = ["first-skill"]
        append_unique(found, ["second-skill", "first-skill", "second-skill"])
        self.assertEqual(found, ["first-skill", "second-skill"])

    def test_every_row_is_eventually_processed(self):
        """长窗口从最早记录分批处理，同毫秒记录必须在同一批。"""
        rows = [(1, "user", "第一条" * 30), (2, "assistant", "第二条" * 30),
                (2, "result", "实际工具成功回执" * 20), (3, "user", "第三条" * 30)]
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "session.v3.jsonl.zstd").touch()
            builder = transcriptBuilder(temp)
            cursor, found = 0, []
            while cursor < 5:
                with patch.object(builder, "_read_session", side_effect=lambda p, a, b: [r for r in rows if a < r[0] <= b]):
                    material = builder.build(cursor, 5, max_chars=120)
                found.append(material["text"])
                self.assertGreater(material["processed_until"], cursor)
                cursor = material["processed_until"]
            combined = "\n".join(found)
            for _, _, text in rows:
                self.assertIn(text, combined)
            self.assertTrue(any("第二条" in text and "实际工具" in text for text in found))
