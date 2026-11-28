"""微服务回归：真实 HTTP/CLI + 伪模型，不加载权重或发送消息。

参数：python -m unittest discover -s tests -p ServiceBoundaryTest.py -v。
随机端口、临时文件由测试持有，验证音频字节、鉴权和生命周期归属。
"""

import concurrent.futures
import contextlib
import importlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "services")]
from services.ServiceRegistry import ServiceRegistry
from services.ServiceClient import ServiceClient
from services.LocalServiceLifecycle import LocalServiceLifecycle

whisper = importlib.import_module("whisperService")
breeze = importlib.import_module("breezeTtsService")


@contextlib.contextmanager
def server_fixture(module, token="test-only-key"):
    """module 为真实音频模块；以假模型替代计算，返回客户端配置和调用记录。"""
    calls = []
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "result.wav"
        with wave.open(str(output), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16000)
            handle.writeframes(b"\0" * 3200)

        def fake_transcribe(path, language, vad_filter=True):
            """读取服务端临时文件，记录实际收到的字节。"""
            calls.append((path, Path(path).read_bytes()))
            return {"ok": True, "text": "欣爱测试", "language": language, "segments": []}

        def fake_speak(*args):
            """记录请求并返回有效 WAV，不调用模型。"""
            calls.append(args)
            return str(output), 0.1, 1

        name = "asr" if module is whisper else "tts"
        key_env = "SYNLOVE_" + name.upper() + "_API_KEY"
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {key_env: token}))
            stack.enter_context(patch.object(module, "transcribe" if module is whisper else "speak",
                                             fake_transcribe if module is whisper else fake_speak))
            if module is breeze:
                stack.enter_context(patch.dict(module._state, {"exit_after_request": False}))
                stack.enter_context(patch.object(module, "free_vram_mb", lambda: 0))
            server = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cfg = {"baseURL": f"http://127.0.0.1:{server.server_port}/v1", "timeoutSeconds": 2,
                   "model": "fake", "apiKeyEnv": key_env, "management": "external",
                   "dialect": "whisper" if name == "asr" else "breeze",
                   "format": "wav", "host": "127.0.0.1", "port": server.server_port}
            try:
                yield cfg, calls, output
            finally:
                server.shutdown()
                server.server_close()
                thread.join(3)


class ServiceBoundaryTest(unittest.TestCase):
    """验证真实音频 HTTP 入口、命令行和故障分支。"""

    def test_tts_binary(self):
        """TTS 返回可解码 WAV，不返回服务端路径。"""
        with server_fixture(breeze) as (cfg, calls, _):
            audio, fmt = ServiceClient(cfg).synthesize("你好")
            self.assertEqual(fmt, "wav")
            with wave.open(io.BytesIO(audio)) as handle:
                self.assertEqual(handle.getnframes(), 1600)
            self.assertEqual(calls[0][0], "你好")

    def test_asr_upload_and_cleanup(self):
        """上传真实字节，转写后删除服务端临时文件。"""
        with server_fixture(whisper) as (cfg, calls, audio):
            result = ServiceClient(cfg).transcribe(audio, "zh")
            self.assertEqual(result["text"], "欣爱测试")
            self.assertEqual(calls[0][1], audio.read_bytes())
            self.assertNotEqual(Path(calls[0][0]), audio)
        self.assertFalse(Path(calls[0][0]).exists())

    def test_auth_denied(self):
        """错误密钥拒绝且不调用模型。"""
        with server_fixture(breeze) as (cfg, calls, _):
            cfg["apiKeyEnv"] = "TEST_WRONG_KEY"
            with patch.dict(os.environ, {"TEST_WRONG_KEY": "wrong"}):
                with self.assertRaisesRegex(RuntimeError, "401"):
                    ServiceClient(cfg).synthesize("你好")
            self.assertEqual(calls, [])

    def test_repeated_auth_denial_keeps_http_status_and_service_alive(self):
        """32次并发错误鉴权保持401，之后正常合成仍可用，不调用未授权模型。"""
        from concurrent.futures import ThreadPoolExecutor
        with server_fixture(breeze) as (cfg, calls, _):
            wrong = {**cfg, "apiKeyEnv": "TEST_WRONG_KEY"}
            def reject_request(_index):
                """索引仅用于并发计数；每个写请求只调用一次。"""
                with self.assertRaisesRegex(RuntimeError, "401"):
                    ServiceClient(wrong).synthesize("人工鉴权测试")
            with patch.dict(os.environ, {"TEST_WRONG_KEY": "wrong"}):
                with ThreadPoolExecutor(max_workers=8) as pool:
                    list(pool.map(reject_request, range(32)))
            self.assertEqual(calls, [])
            self.assertTrue(ServiceClient(cfg).synthesize("正常请求")[0])

    def test_external_never_spawn(self):
        """外部服务离线也不能补拉本机进程。"""
        with patch("subprocess.Popen") as spawn:
            for name in ("tts", "asr"):
                LocalServiceLifecycle(name, {"management": "external"}).ensure_service()
            spawn.assert_not_called()

    def test_managed_custom_port_reuses_healthy_service(self):
        """本机自定义端口已有健康服务时，不重复启动。"""
        with server_fixture(whisper) as (cfg, _, _):
            cfg["management"] = "managed"
            with patch("subprocess.Popen") as spawn:
                LocalServiceLifecycle("asr", cfg).ensure_service()
                spawn.assert_not_called()

    def test_managed_unhealthy_port_does_not_spawn_duplicate(self):
        """端口已被无效服务占用时立即报告，不能重复拉起另一个消费者。"""
        with server_fixture(whisper) as (cfg, _, _):
            cfg["management"] = "managed"
            cfg["apiKeyEnv"] = "TEST_UNHEALTHY_KEY"
            with patch.dict(os.environ, {"TEST_UNHEALTHY_KEY": "wrong"}), patch("subprocess.Popen") as spawn:
                with self.assertRaisesRegex(RuntimeError, "端口已监听"):
                    LocalServiceLifecycle("asr", cfg).ensure_service()
                spawn.assert_not_called()

    def test_response_size_limit(self):
        """完整响应超出调用方上限时明确失败。"""
        with server_fixture(breeze) as (cfg, _, _):
            with self.assertRaisesRegex(ValueError, "大小上限"):
                ServiceClient(cfg).request("/audio/speech", b'{"input":"test"}', "application/json", limit=16)

    def test_standard_tts_omits_native_options(self):
        """严格的远程供应商只收到标准字段，不能混入 Breeze 自定义参数。"""
        client = ServiceClient({"model": "remote", "format": "wav", "voice": "alloy"})
        with patch.object(client, "request", return_value=(b"audio", "audio/wav")) as request:
            client.synthesize("你好", instruction="甜美", cfgScale=4, seed=42)
            payload = json.loads(request.call_args[0][1])
            self.assertEqual(set(payload), {"model", "input", "voice", "response_format"})
            self.assertEqual(payload["voice"], "alloy")

    def test_registry_rejects_remote_managed(self):
        """远程地址不允许自动托管。"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ServiceConfig.json"
            path.write_text(json.dumps({"version": 1, "services": {"tts": {
                "baseURL": "https://example.invalid/v1", "management": "managed"}}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "回环"):
                ServiceRegistry(path).get_service("tts")

    def test_registry_override_defaults_external(self):
        """单独覆盖地址时自动退出托管，并关闭本机显存门控。"""
        with patch.dict(os.environ, {"SYNLOVE_LLM_BASE_URL": "https://example.invalid/v1"}):
            registry = ServiceRegistry()
            cfg = registry.get_service("llm")
            self.assertEqual(cfg["management"], "external")
            env = {}
            registry.apply_environment(env)
            self.assertEqual(env["DSH_GEMMA_MIN_FREE_VRAM_MB"], "0")
            self.assertEqual(env["GEMMA_LOCAL_BASE_URL"], cfg["baseURL"])

    def test_session_service_environment_is_explicit(self):
        """session 模式、远程地址和超时必须进入 Harness 子进程环境，避免默认双写。"""
        registry = ServiceRegistry()
        env = {}
        registry.apply_environment(env)
        session = registry.get_service("session")
        self.assertEqual(env["SYNLOVE_SESSION_MODE"], session["mode"])
        self.assertEqual(env["SYNLOVE_SESSION_BASE_URL"], session["baseURL"])
        self.assertEqual(env["SYNLOVE_SESSION_TIMEOUT_MS"], str(int(session["timeoutSeconds"] * 1000)))

    def test_harness_provider_has_usable_no_auth_reference(self):
        """无鉴权模型也必须满足 Harness 非空凭据约定，且不能继承旧供应商密钥。"""
        import start_stack
        cfg = {"providers": {"gemma-local": {
            "apiKey": "old-provider-key", "models": [{"id": "old"}, {"id": "old2"}],
        }}, "defaultModel": {"provider": "gemma-local", "model": "old"}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "serviceConfig.json"
            path.write_text(json.dumps({"version": 1, "services": {"llm": {
                "baseURL": "http://127.0.0.1:8080/v1", "management": "external",
                "model": "test-gemma", "provider": "gemma-local", "apiKeyRef": ""}}}), encoding="utf-8")
            ServiceRegistry(path).apply_model_config(cfg, {})
        provider = cfg["providers"]["gemma-local"]
        self.assertEqual(provider["apiKey"], "synlove-no-auth")
        self.assertEqual(start_stack.collect_secrets(cfg)[provider["apiKeyEnv"]], "synlove-no-auth")
        self.assertEqual(len(provider["models"]), 1)
        self.assertEqual(provider["models"][0]["id"], cfg["defaultModel"]["model"])

    def test_bad_format_and_json(self):
        """不支持的格式和无效 JSON 返回 400。"""
        with server_fixture(breeze) as (cfg, calls, _):
            with self.assertRaisesRegex(RuntimeError, "400"):
                ServiceClient(cfg).synthesize("你好", response_format="mp3")
            with self.assertRaisesRegex(RuntimeError, "400"):
                ServiceClient(cfg).request("/audio/speech", b"[1]", "application/json")
            self.assertEqual(calls, [])

    def test_asr_missing_upload(self):
        """跨机器入口拒绝文件路径 JSON。"""
        with server_fixture(whisper) as (cfg, calls, _):
            with self.assertRaisesRegex(RuntimeError, "400"):
                ServiceClient(cfg).request("/audio/transcriptions", b'{"path":"x"}', "application/json")
            self.assertEqual(calls, [])

    def test_concurrent_requests_are_bounded(self):
        """压力中允许繁忙拒绝，成功响应完整，服务压力后仍可用。"""
        with server_fixture(breeze) as (cfg, _, _):
            def run(index):
                """index 区分并发请求；记录成功或明确的繁忙状态。"""
                try:
                    audio, _ = ServiceClient(cfg).synthesize("测试" + str(index))
                    self.assertTrue(audio.startswith(b"RIFF"))
                    return "ok"
                except RuntimeError as error:
                    self.assertIn("429", str(error))
                    return "busy"
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(run, range(32)))
            self.assertEqual(len(results), 32)
            self.assertIn("ok", results)
            self.assertTrue(ServiceClient(cfg).synthesize("结束")[0].startswith(b"RIFF"))

    def test_cli_asr(self):
        """真实 CLI 读取配置并上传音频，不启动本机模型。"""
        with server_fixture(whisper) as (cfg, _, audio):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "ServiceConfig.json"
                path.write_text(json.dumps({"version": 1, "services": {"asr": cfg}}), encoding="utf-8")
                env = {**os.environ, "SYNLOVE_SERVICE_CONFIG": str(path), "PYTHONUTF8": "1"}
                result = subprocess.run([sys.executable, str(ROOT / "tools" / "transcribe.py"), str(audio)],
                                        env=env, capture_output=True, text=True, encoding="utf-8", timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("欣爱测试", result.stdout)

    def test_cli_tts(self):
        """真实 CLI 将远程字节保存为调用机文件。"""
        with server_fixture(breeze) as (cfg, _, audio):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "ServiceConfig.json"
                path.write_text(json.dumps({"version": 1, "services": {"tts": cfg}}), encoding="utf-8")
                env = {**os.environ, "SYNLOVE_SERVICE_CONFIG": str(path), "PYTHONUTF8": "1"}
                result = subprocess.run([sys.executable, str(ROOT / "tools" / "speak.py"), "你好"],
                                        env=env, capture_output=True, text=True, encoding="utf-8", timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                target = Path(result.stdout.strip().splitlines()[-1])
                safe = target.is_relative_to(ROOT / "runtime" / "tts") and target.suffix == ".wav"
                self.assertTrue(safe)
                try:
                    self.assertEqual(target.read_bytes(), audio.read_bytes())
                finally:
                    if safe:
                        target.unlink(missing_ok=True)

    def test_launcher_external_never_spawn_or_wait_gpu(self):
        """真实启动器函数在外部模式不探测 GPU、不补拉模型。"""
        import start_stack
        with patch.dict(os.environ, {"SYNLOVE_LLM_BASE_URL": "https://example.invalid/v1"}):
            with patch.object(start_stack, "wait_for_gpu_free") as gpu, patch("subprocess.Popen") as spawn:
                env = {}
                self.assertEqual(start_stack.ensure_gemma_server(env), "external")
                gpu.assert_not_called()
                spawn.assert_not_called()

    def test_guard_does_not_restart_for_external(self):
        """外部服务由部署平台管理，本机巡检不重启整个系统。"""
        sys.path.insert(0, str(ROOT / "tools"))
        guard = importlib.import_module("guardService")
        with patch.dict(os.environ, {"SYNLOVE_LLM_BASE_URL": "https://example.invalid/v1"}):
            with patch.object(guard, "restart_stack") as restart, patch.object(guard, "_preset_evidence", return_value={}):
                guard.check_semantic_health()
                self.assertIsNone(guard._health["gemma_ok"])
                restart.assert_not_called()

    def test_video_uses_upload_and_never_unloads_external(self):
        """视频 ASR 也上传字节，external 模式不发送卸载请求。"""
        from videoDigest.steps.audioSteps import speechRecognizer
        with server_fixture(whisper) as (cfg, calls, audio):
            with patch.object(ServiceRegistry, "get_service", return_value=cfg):
                recognizer = speechRecognizer({})
                result = recognizer.transcribe(audio)
                self.assertEqual(result["text"], "欣爱测试")
                self.assertEqual(calls[0][1], audio.read_bytes())
                self.assertFalse(hasattr(recognizer, "unload"))

    def test_video_large_wav_chunks(self):
        """长音频分块上传并还原每块的时间偏移。"""
        import videoDigest.steps.audioSteps as steps
        with server_fixture(whisper) as (cfg, calls, _):
            original = whisper.transcribe

            def transcribe_segments(*args):
                """给假转写补时间戳，验证分块聚合不会重置时间线。"""
                result = original(*args)
                result["segments"] = [{"start": 0, "end": 0.01, "text": "测试"}]
                return result

            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "long.wav"
                with wave.open(str(path), "wb") as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(16000)
                    audio.writeframes(b"\0" * 16000)
                with patch.object(ServiceRegistry, "get_service", return_value=cfg), \
                        patch.object(steps, "MAX_AUDIO", 8192), patch.object(whisper, "transcribe", transcribe_segments):
                    recognizer = steps.speechRecognizer({})
                    result = recognizer.transcribe(path)
                self.assertEqual(len(calls), 4)
                self.assertEqual(result["text"], "欣爱测试" * 4)
                self.assertTrue(all(len(raw) < 8192 for _, raw in calls))
                self.assertEqual([part["start"] for part in result["segments"]], [0, 0.128, 0.256, 0.384])


if __name__ == "__main__":
    unittest.main()
