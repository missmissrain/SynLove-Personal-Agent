"""Relay 服务信任与凭据传播回归：使用临时配置和替身，不连接真实服务。

运行参数：python -m unittest tests.ServiceTlsTests。默认无模型、无平台消息。
"""

import json
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.ServiceTls import ServiceTls
from services.ServiceRegistry import ServiceRegistry


class ServiceTlsTests(unittest.TestCase):
    """验证显式 CA、主机身份检查及三类能力的统一鉴权环境。"""

    def test_system_trust_keeps_verification(self):
        """无参数；默认上下文必须开启证书链与主机名校验。"""
        ctx = ServiceTls.create_context({})
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)

    def test_explicit_ca_loads_and_missing_ca_fails(self):
        """无参数；配置的 CA 必须确实加载，文件缺失不能降级成跳过验证。"""
        with tempfile.TemporaryDirectory() as folder:
            ca = Path(folder) / "ca.pem"
            ca.write_text("isolated-fixture", encoding="ascii")
            with patch("services.ServiceTls.ssl.create_default_context") as make:
                ctx = ServiceTls.create_context({"tlsCaFile": str(ca)})
                ctx.load_verify_locations.assert_called_once_with(cafile=str(ca.resolve()))
                make.assert_called_once_with()
            with self.assertRaises(ValueError):
                ServiceTls.create_context({"tlsCaFile": str(ca.with_name("missing.pem"))})

    def test_audio_and_llm_receive_same_configured_credentials(self):
        """无参数；外部 TTS、ASR、LLM 均注入密钥，Node 子进程取得 CA，不改变存储模式。"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "config").mkdir()
            ca = root / "ca.pem"
            ca.write_text("isolated-fixture", encoding="ascii")
            services = {name: {
                "baseURL": "https://relay.example.test/v1", "model": "test",
                "management": "external", "tlsCaFile": str(ca),
                "apiKeyEnv": "TEST_" + name.upper(), "apiKeyRef": "backendService"
            } for name in ("tts", "asr", "llm")}
            file = root / "config" / "serviceConfig.json"
            file.write_text(json.dumps({"version": 1, "services": services}), encoding="utf-8")
            registry = ServiceRegistry(file)
            env = {}
            with patch("services.ServiceRegistry.ServiceCredential.resolve_key", return_value="test-key"):
                registry.apply_environment(env)
            for name in ("tts", "asr", "llm"):
                self.assertEqual(env["TEST_" + name.upper()], "test-key")
            self.assertEqual(env["NODE_EXTRA_CA_CERTS"], str(ca.resolve()))
            self.assertEqual(env["SYNLOVE_STATE_MODE"], "local")
