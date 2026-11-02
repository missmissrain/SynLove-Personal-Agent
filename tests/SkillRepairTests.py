"""技能沉淀与固定自修功能测试。使用临时目录和可控编码器，不连接模型或正式消息通道。"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from codeRepair import codeRepair
from skills.store.skillStore import skillStore
from skills.review.skillReviewer import skillReviewer
from skills.review.llmClient import llmClient
from skills.config.configLoader import skillReviewConfig

SKILL = """---
name: network-check
description: 网络接口失联时先检查身份与连通性
version: 1.0.0
metadata:
  hermes:
    tags: [network]
    category: 系统维护
---
# 接口连通性核查
## 何时使用
用户明确要求检查服务失联、延迟或错误响应时使用；只针对已登记的服务。
## 步骤
1. 读取已有配置中的服务别名，确认授权对象和请求的超时，不读取不相关凭据。
2. 发起固定健康请求，核对返回的协议与服务身份，不把端口监听当成业务成功。
3. 整理真实状态和时间，执行失败时保留原始错误事实，不重复提交写操作。
## 坑
- 服务返回错误时不能报告成功，网络超时后写操作可能已经生效，必须先查状态。
## 验证
再次读取同一条请求的结果，确认身份、状态和测试产生的记录一致，然后给出结论。
"""


class SkillRepairTests(unittest.TestCase):
    def test_invalid_review_cannot_advance_watermark(self):
        """空正文及未完成工具循环必须返回错误，不能作为已复盘成功。"""
        from types import SimpleNamespace
        cfg = {"minTurns":1,"maxIterations":1}
        for message in ({"content":""},{"content":"不符合技能协议"}):
            with tempfile.TemporaryDirectory() as temp:
                llm = SimpleNamespace(chat=lambda *args,**kwargs:{"message":message})
                result = skillReviewer(cfg,skillStore(temp),llm).review({"turns":4,"text":"人工测试"})
                self.assertTrue(result.get("error"))

    def test_repair_evidence_redacts_credentials(self):
        """编码器证据必须过滤令牌、口令、地址、邮箱及用户目录。"""
        from tools.LogRedactor import LogRedactor
        raw = 'Authorization: Bearer fixture-secret token="fixture-token" password=fixture-pass https://example.test/x user@example.test C:\\Users\\FixtureUser\\logs'
        clean = LogRedactor.redact_text(raw)
        for private in ("fixture-secret", "fixture-token", "fixture-pass", "example.test", "FixtureUser"):
            self.assertNotIn(private, clean)

    def test_process_probe_does_not_terminate_child(self):
        """进程探活不发送信号，真实子进程保持运行，退出后能识别。"""
        import subprocess
        from tools.ProcessProbe import ProcessProbe
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(15)"],
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            self.assertTrue(ProcessProbe.process_alive(child.pid))
            self.assertIsNone(child.poll())
        finally:
            child.terminate()
            child.wait(timeout=10)
        self.assertFalse(ProcessProbe.process_alive(child.pid))
        self.assertFalse(ProcessProbe.process_alive(-1))

    def test_persist_failure_reaches_review_result(self):
        """磁盘写入失败必须出现在复盘错误中，防止外层推进已处理游标。"""
        from skills.review.reviewTools import reviewTools
        with tempfile.TemporaryDirectory() as temp:
            store = skillStore(temp)
            tools = reviewTools(store, {"text": ""}, 3)
            with patch("skills.store.skillStore.FILE_WRITER.write_text", return_value=False):
                tools.call("save_skill", {"name": "network-check", "content": SKILL})
            self.assertTrue(tools.result().get("error"))
            self.assertIsNone(store.read_skill("../outside"))

    """核验持久化、降级端点、互斥、自修启动、语法拒绝与回滚。"""

    def test_skill_create_stage_and_failed_write(self):
        """新技能创建、更新待审；持久写入失败不能虚报成功。"""
        with tempfile.TemporaryDirectory() as temp:
            store = skillStore(temp)
            self.assertEqual(store.save("network-check", SKILL)["action"], "created")
            original = store.read_skill("network-check")
            self.assertEqual(store.save("network-check", SKILL + "\n补充规则。")["action"], "staged")
            self.assertEqual(store.read_skill("network-check"), original)
            with patch("skills.store.skillStore.FILE_WRITER.write_text", return_value=False):
                self.assertEqual(store.save("other-check", SKILL.replace("network-check","other-check"))["action"],"skipped")
                self.assertEqual(store.save("network-check", SKILL + "\n失败写入。")["action"],"skipped")
            self.assertIsNone(store.read_skill("other-check"))
            self.assertEqual(store.save("../escape", SKILL)["action"], "skipped")

    def test_reviewer_extracts_real_skill_and_dry_run_isolated(self):
        """真实复盘工具循环可落盘，dry-run不污染正式技能目录。"""
        class Fixture:
            """返回固定工具调用，模拟提炼而不调用模型。"""
            def __init__(self): self.count = 0
            def chat(self, messages, tools):
                """messages、tools 为真实复盘接口；先保存，再结束。"""
                self.count += 1
                name = "save_skill" if self.count == 1 else "finish"
                args = {"name":"network-check","content":SKILL} if self.count == 1 else {"summary":"完成"}
                return {"message":{"tool_calls":[{"id":str(self.count),"type":"function",
                    "function":{"name":name,"arguments":json.dumps(args)}}]}}
        with tempfile.TemporaryDirectory() as temp:
            store = skillStore(temp)
            transcript = {"turns":4,"text":"用户要求测试接口；执行者验证了健康协议，并说明失败不可重提。"}
            result = skillReviewer({"minTurns":4},store,Fixture()).review(transcript,dry_run=True)
            self.assertIsNone(store.read_skill("network-check"))
            result = skillReviewer({"minTurns":4},store,Fixture()).review(transcript)
            self.assertEqual(result["saved"],["network-check"])
            self.assertTrue(result["finished"])
            self.assertTrue(Path(temp,"network-check","SKILL.md").is_file())

    def test_skill_fallback_uses_service_registry(self):
        """Gemma降级复用登记远端服务，不访问旧本机8080。"""
        target={"provider":"gemma","baseUrl":"http://127.0.0.1:1/v1","model":"obsolete"}
        with patch("services.ServiceRegistry.ServiceRegistry.get_service",return_value={
                "model":"remote-gemma","baseURL":"https://backend.example.test/v1"}), \
             patch("services.ServiceClient.ServiceClient.chat",return_value={"choices":[{"message":{"content":SKILL}}]}) as call:
            result=llmClient(target).chat([{"role":"user","content":"提炼"}])
            self.assertEqual(result["model"],"remote-gemma")
            self.assertEqual(call.call_args[0][0]["model"],"remote-gemma")

    def test_skills_directory_matches_instance(self):
        """默认技能目录属于项目实例，不能沉淀到已退出使用的用户.dsh。"""
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,{},clear=False):
            os.environ.pop("DSH_HOME",None)
            cfg=skillReviewConfig(temp)
            self.assertEqual(Path(cfg.get("skillsDir")),Path(temp,"runtime","dsh","skills"))

    def test_repair_rolls_back_broken_code_and_keeps_valid_fix(self):
        """运行固定自修流程，坏代码回滚，正确修改通过静态验证。"""
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); target=root/"source"; target.mkdir()
            file=target/"RepairTarget.py";file.write_text("value = 1\n")
            repair=codeRepair(root,targets=[target],cooldown=0,cli_chain=("codex",))
            def broken(_prompt):
                """模拟编码器写入坏代码；不调用真实CLI。"""
                file.write_text("def invalid(\n")
                return True,"模拟修改"
            with patch.object(repair,"_codex",side_effect=broken):
                result=repair.attempt("模拟故障")
            self.assertFalse(result["ok"]);self.assertEqual(file.read_text(),"value = 1\n")
            def fixed(_prompt):
                """模拟编码器生成可解析修复。"""
                file.write_text("value = 2\n")
                return True,"模拟修复"
            with patch.object(repair,"_codex",side_effect=fixed):
                self.assertTrue(repair.attempt("模拟故障")["ok"])
            self.assertEqual(file.read_text(),"value = 2\n")
            other=codeRepair(root,targets=[target],cooldown=9999)
            with patch.object(other,"_codex") as cli:
                self.assertFalse(other.attempt("冷却测试")["ok"])
                cli.assert_not_called()

    def test_repair_rejects_bad_javascript_and_serializes(self):
        """JavaScript语法错误不能通过自修验收；重复自修不能持有同一个锁。"""
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);target=root/"source";target.mkdir()
            file=target/"RepairTarget.mjs";file.write_text("const = ;")
            repair=codeRepair(root,targets=[target])
            ok,_=repair._verify({"changed":[str(file)],"created":[],"deleted":[]})
            self.assertFalse(ok)
            self.assertTrue(repair._acquire_lock())
            try: self.assertFalse(codeRepair(root,targets=[target])._acquire_lock())
            finally: repair._release_lock()

    def test_repair_cli_launch_is_real_noninteractive_process(self):
        """固定启动函数确实能启动进程并返回真实退出码；stdin关闭。"""
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);repair=codeRepair(root,targets=[root])
            ok,output=repair._run([sys.executable,"-c","import sys;print('fixture-ready');sys.exit(0)"],root,10)
            self.assertTrue(ok);self.assertEqual(output,"fixture-ready")
            ok,_=repair._run([sys.executable,"-c","raise SystemExit(3)"],root,10)
            self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
