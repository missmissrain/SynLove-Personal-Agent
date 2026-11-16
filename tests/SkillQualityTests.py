"""技能质量回归：使用假模型、临时目录和模拟网络，验证低证据候选隔离及代理选择。
参数无；不会调用真实模型、读取私人聊天或发送用户通知。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from skills.review.SkillQualityGate import SkillQualityGate
from skills.review.skillReviewer import skillReviewer
from skills.review.llmClient import llmClient
from skills.store.skillStore import skillStore
from SkillRepairTests import SKILL


class SkillQualityTests(unittest.TestCase):
    """防止无依据或降级产物直接成为可执行规则。"""

    def test_missing_evidence_is_staged(self):
        """格式正确但没有工具依据的产物仅待审，不能自动挂载。"""
        self._check_review(False, False, "staged")

    def test_evidenced_primary_can_create(self):
        """主模型引用本轮真实回执时允许创建，仍保留语义审查边界。"""
        self._check_review(False, True, "saved")

    def test_fallback_is_always_staged(self):
        """降级模型即使引用正确回执，也只能生成待审候选。"""
        self._check_review(True, True, "staged")

    def test_forged_or_failed_quote_cannot_pass(self):
        """模型编造引用或引用失败回执时，均不能取得自动入库资格。"""
        quote = "这段文字声称接口操作已经通过验证并成功执行。"
        content = SKILL + "\n## 依据\n> " + quote
        for evidence in ([], ["status=error " + quote],
                         ['status=returned {"ok":false} ' + quote]):
            self.assertTrue(SkillQualityGate({"evidence": evidence}).review_content(content))

    def test_direct_proxy_does_not_inherit_environment(self):
        """direct 模式明确关闭代理；environment 模式保留现有代理机制。"""
        for mode in ("direct", "environment"):
            opener = MagicMock()
            response = opener.open.return_value.__enter__.return_value
            response.read.return_value = json.dumps({"choices":[{"message":{"content":"Nothing to save."}}]}).encode()
            with patch("skills.review.llmClient.urllib.request.build_opener", return_value=opener) as build:
                llmClient({"baseUrl":"https://example.test/v1","model":"fixture",
                           "proxyMode":mode}).chat([])
                if mode == "direct":
                    self.assertEqual(build.call_args.args[0].proxies, {})
                else:
                    self.assertEqual(build.call_args.args, ())

    def _check_review(self, fallback, with_evidence, expected):
        """fallback、with_evidence 为模型与证据开关；expected 为唯一允许的持久化结果。"""
        quote = "实际健康接口返回状态正常并确认协议握手已成功完成。"
        content = SKILL + ("\n## 依据\n> " + quote if with_evidence else "")
        transcript = {"turns":4,"text":"用于隔离验证的对话素材",
                      "evidence":["status=returned " + quote] if with_evidence else []}
        model = MagicMock()
        model.chat.return_value = {"message":{"content":content},"fallback":fallback}
        with tempfile.TemporaryDirectory() as temp:
            store = skillStore(temp)
            result = skillReviewer({}, store, model).review(transcript)
            self.assertTrue(result["finished"])
            self.assertEqual(result[expected], ["network-check"])
            self.assertEqual((Path(temp)/"network-check/SKILL.md").exists(), expected == "saved")
            before = sorted(str(p) for p in Path(temp).rglob("*"))
            skillReviewer({}, store, model).review(transcript, dry_run=True)
            self.assertEqual(before, sorted(str(p) for p in Path(temp).rglob("*")))
