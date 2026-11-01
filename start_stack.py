"""微信 Harness 统一启动器：从 config/modelConfig.json 加载模型、密钥与访问地址，拉起后台服务。

运行参数：无。
- 模型/密钥/地址的唯一来源是 config/modelConfig.json（明文，便于后续脱敏；迁移时只改这一个文件）。
- 密钥写入 Harness 托管凭据文件 $DSH_HOME/.credentials.yaml（refs 段），**不再依赖环境变量**：
  harness 的解析优先级是「进程环境变量 > 托管凭据文件」，所以只要进程环境里没有同名变量，
  就以本文件为准；每次启动会检测并提示会被环境变量遮蔽的项。
- baseURL 等非机密项仍注入环境变量，便于 patch 里的 !!js 表达式读取。
- 同时把 provider 列表与默认模型写入 $DSH_HOME/settings.yaml（写入前备份），保证生效层与 JSON 一致。
微信连接是一次性操作：token 持久化在本地账号文件中，仅在断连需要重新扫码时才运行登录入口。
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import yaml
from services.ServiceRegistry import ServiceRegistry
from services.StartupState import StartupState
from services.StartupServices import StartupServices


PROJECT_ROOT = Path(__file__).resolve().parent
HARNESS_ROOT = PROJECT_ROOT / "backend"
HARNESS_SCRIPT = PROJECT_ROOT / "config" / "startHarnessBackend.ps1"
CONFIG_JSON = PROJECT_ROOT / "config" / "modelConfig.json"
# 密钥单独存放（apiKey / 微信 token / TTS 凭据），启动时合并进内存配置；见 merge_secrets()。
SECRETS_JSON = PROJECT_ROOT / "config" / "secrets.json"
DSH_HOME = Path(os.environ.get("DSH_HOME") or (PROJECT_ROOT / "runtime" / "dsh"))
os.environ.setdefault("DSH_HOME", str(DSH_HOME))
SETTINGS_FILE = DSH_HOME / "settings.yaml"
CREDENTIALS_FILE = DSH_HOME / ".credentials.yaml"
# 运行期由 webhook 写下的"微信 token 失效"标记（ret=-2 时触发）。
TOKEN_INVALID_FLAG = DSH_HOME / "weixin-token-invalid.flag"
# 协议/推理调节：wireZh=中文短协议；reasoningOff=关闭思考链（更快、更省）。
TUNING_FILE = PROJECT_ROOT / "config" / "harnessTuning.json"


def load_tuning() -> dict:
    """读协议/推理调节开关，文件缺失时返回空 dict（= 不改默认行为）。"""
    try:
        return json.loads(TUNING_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
# 外部可执行文件一律"环境变量优先 → PATH 查找"，不再写死本机绝对路径（便于拷贝到别的机器）。
def _resolve_bin(env_name: str, *candidates: str, default: str) -> Path:
    configured = os.environ.get(env_name)
    if configured and Path(configured).exists():
        return Path(configured)
    for name in candidates:
        found = shutil.which(name)
        if found:
            return Path(found)
    return Path(default)


OPENCODE_BIN = _resolve_bin("OPENCODE_BIN", "opencode", "opencode.cmd", default="opencode")
OPENCODE_SERVER_PORT = int(os.environ.get("OPENCODE_SERVER_PORT") or "4096")
OPENCODE_SERVER_URL = os.environ.get("OPENCODE_SERVER_URL") or ("http://127.0.0.1:%d" % OPENCODE_SERVER_PORT)
# 本地 Gemma 默认放在**本项目的同级目录**（.../智能秘书/Gemma4），不再写死盘符。
GEMMA_ROOT = Path(os.environ.get("GEMMA_ROOT") or (PROJECT_ROOT / "gemma"))
GEMMA_SERVER_PORT = int(os.environ.get("GEMMA_SERVER_PORT") or "8080")


def merge_secrets(config: dict) -> dict:
    """把 config/secrets.json 里的密钥**合并回**配置对象。

    拆分的理由：modelConfig.json 既要描述"用哪些模型"，又要装密钥，一旦要分享/备份
    /排查模型列表就有泄密风险。现在密钥单独放 secrets.json，这里合并成一份内存对象 ——
    下游（注入环境变量、同步凭据、渲染 settings、取微信 token）**一行都不用改**。

    secrets.json 不存在也不报错（只是没有密钥），方便别人拿到代码后自己填。
    """
    if not SECRETS_JSON.is_file():
        return config
    try:
        secrets = json.loads(SECRETS_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print("WARNING: secrets.json 解析失败，本次不注入密钥：" + str(error))
        return config

    for name, block in (secrets.get("providers") or {}).items():
        provider = (config.get("providers") or {}).get(name)
        if provider is not None and block.get("apiKey"):
            provider["apiKey"] = block["apiKey"]
    weixin_secret = secrets.get("weixin") or {}
    if weixin_secret.get("token"):
        config.setdefault("weixin", {})["token"] = weixin_secret["token"]
    tts_secret = secrets.get("tts") or {}
    for field in ("httpApiKey", "accessToken", "appId"):
        if tts_secret.get(field):
            config.setdefault("tts", {})[field] = tts_secret[field]
    # QQ 官方机器人凭据（可选通道）：secrets.json 的 qq 段。
    qq_secret = secrets.get("qq") or {}
    if qq_secret.get("appId") and qq_secret.get("clientSecret"):
        config["qq"] = {"appId": str(qq_secret["appId"]), "clientSecret": str(qq_secret["clientSecret"])}
    return config


def load_model_config() -> dict:
    """读取模型定义（config/modelConfig.json），并把 config/secrets.json 的密钥合并进来。

    对下游来说这仍是"模型/密钥/地址的唯一来源"（一份内存对象），只是磁盘上分了两个文件：
    模型定义可分享，密钥单独存放。
    """
    if not CONFIG_JSON.is_file():
        raise FileNotFoundError("模型配置不存在: " + str(CONFIG_JSON))
    config = json.loads(CONFIG_JSON.read_text(encoding="utf-8"))
    return merge_secrets(config)


def collect_secrets(config: dict) -> dict[str, str]:
    """从 JSON 汇总「凭据名 -> 明文值」：各 provider 的 apiKey、微信 token、TTS 凭据。"""
    secrets: dict[str, str] = {}
    for provider in config.get("providers", {}).values():
        if provider.get("apiKeyEnv") and provider.get("apiKey"):
            secrets[provider["apiKeyEnv"]] = str(provider["apiKey"])
    weixin = config.get("weixin", {})
    if weixin.get("tokenEnv") and weixin.get("token"):
        secrets[weixin["tokenEnv"]] = str(weixin["token"])
    tts = config.get("tts", {})
    for env_key, field in (("httpApiKeyEnv", "httpApiKey"), ("appIdEnv", "appId"), ("accessTokenEnv", "accessToken")):
        if tts.get(env_key) and tts.get(field):
            secrets[tts[env_key]] = str(tts[field])
    return secrets


def sync_credentials(config: dict) -> tuple[int, list[str]]:
    """把 JSON 里的密钥写进 Harness 托管凭据文件 $DSH_HOME/.credentials.yaml 的 refs 段。

    只增改自己管理的 ref，保留文件里其它内容（records、别人的 ref）；
    写入前备份，临时文件 + 替换保证原子性。返回 (写入条数, 被环境变量遮蔽的 ref 列表)。
    """
    secrets = collect_secrets(config)
    document: dict = {}
    if CREDENTIALS_FILE.is_file():
        loaded = yaml.safe_load(CREDENTIALS_FILE.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            document = loaded
        shutil.copyfile(CREDENTIALS_FILE,
                        CREDENTIALS_FILE.with_name(CREDENTIALS_FILE.name + ".bak-" + time.strftime("%Y%m%d-%H%M%S")))
    refs = document.get("refs")
    if not isinstance(refs, dict):
        refs = {}
    document.setdefault("version", 1)
    document["refs"] = refs
    for ref, value in secrets.items():
        refs[ref] = value
    CREDENTIALS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = CREDENTIALS_FILE.with_name(CREDENTIALS_FILE.name + ".tmp")
    temporary.write_text(yaml.safe_dump(document, allow_unicode=True, sort_keys=False), encoding="utf-8")
    temporary.replace(CREDENTIALS_FILE)
    # 环境变量优先级更高：进程环境里若已存在同名变量，会遮蔽刚写入的值，必须提示。
    shadowed = sorted(ref for ref in secrets if os.environ.get(ref))
    return len(secrets), shadowed


def remember_python_for_console() -> None:
    """把自己的解释器路径记进 config/console.env（仅在缺失时写）。

    控制台要用 Python 重启链路，但它没法可靠猜到哪一个是能跑通本项目的解释器
    （本机 `python` 指向的那份未必装了 PyYAML）。这里让**能跑通的这个**自报家门，
    控制台直接复用，既准确又可移植。
    """
    path = PROJECT_ROOT / "config" / "console.env"
    try:
        existing = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
        prefix = "" if existing.endswith("\n") or existing == "" else "\n"
        additions: list[str] = []
        if "PYTHON=" not in existing:
            additions.append("# 由 start_stack.py 记录：能跑通本项目的解释器\nPYTHON=%s" % sys.executable)
        if "CONSOLE_NODE=" not in existing:
            # 控制台的本地服务用了 node:sqlite（Node 22.5+），**Electron 自带的 Node 20 跑不了**，
            # 所以这里把真 node 的位置也记下来，供桌面壳直接复用（详见 electron-main.js 的 resolve_node）。
            # 名字带 CONSOLE_ 前缀，免得和 Node 自己的环境变量（NODE_OPTIONS 等）混在一起。
            node = shutil.which("node")
            if node:
                additions.append("# 由 start_stack.py 记录：真 Node（控制台的本地服务需要它）\nCONSOLE_NODE=%s" % node)
        if additions:
            with path.open("a", encoding="utf-8") as handle:
                handle.write("%s\n%s\n" % (prefix, "\n".join(additions)))
    except OSError:
        pass


def load_console_env(env: dict[str, str]) -> list[str]:
    """读取控制台（console/server.mjs）写入的开关覆盖。

    控制台把"需要重启才生效"的功能开关写进 config/console.env（KEY=VALUE），
    这里读出来注入环境。**已存在的环境变量优先**，避免覆盖外部显式设置。
    """
    path = PROJECT_ROOT / "config" / "console.env"
    if not path.is_file():
        return []
    applied: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key and not env.get(key):
            env[key] = value
            applied.append(key)
    return applied


def apply_environment(config: dict, env: dict[str, str]) -> None:
    """把 JSON 中的**地址**注入子进程环境；密钥走托管凭据文件，不再进环境变量。"""
    registry = ServiceRegistry()
    registry.apply_model_config(config)
    registry.apply_environment(env)
    for provider in config.get("providers", {}).values():
        base_env = provider.get("baseURLEnv")
        if base_env and provider.get("baseURL") and not env.get(base_env):
            env[base_env] = provider["baseURL"]
    weixin = config.get("weixin", {})
    # 微信 token 既写凭据文件，也注入环境变量：webhook 的 profile patch 用 !!js process.env 读取。
    for env_name, field in (("baseURLEnv", "baseURL"), ("cdnBaseURLEnv", "cdnBaseURL"), ("tokenEnv", "token")):
        name = weixin.get(env_name)
        if name and weixin.get(field) and not env.get(name):
            env[name] = weixin[field]
    default = config.get("defaultModel", {})
    env["DSH_DEFAULT_PROVIDER"] = default.get("provider", "")
    env["DSH_DEFAULT_MODEL"] = default.get("model", "")
    env["DSH_STACK_ROOT"] = str(PROJECT_ROOT)
    # QQ 官方机器人通道（可选）：有凭据才注入，profile patch 里那行按 QQ_BOT_APP_ID 决定是否挂载。
    qq = config.get("qq") or {}
    if qq.get("appId") and qq.get("clientSecret"):
        env["QQ_BOT_APP_ID"] = str(qq["appId"])
        env["QQ_BOT_CLIENT_SECRET"] = str(qq["clientSecret"])
    # 共享会话（用户要求"微信和 QQ 单聊聊同一段"）：两边都读 $DSH_HOME/shared-session.txt，
    # 微信侧负责在"清空上下文"后改写它（带代次后缀），QQ 每次读文件跟随。
    # 不想要共享时把这里删掉或设 DSH_SESSION_SHARED=0 即可回到各自独立会话。
    if os.environ.get("DSH_SESSION_SHARED", "1").strip() not in {"0", "off", "false"}:
        shared_file = DSH_HOME / "shared-session.txt"
        try:
            DSH_HOME.mkdir(parents=True, exist_ok=True)
            if not shared_file.exists() or shared_file.read_text(encoding="utf-8-sig").strip() == "":
                shared_file.write_text("main\n", encoding="utf-8")
            env["DSH_SESSION_SHARED"] = "1"
        except OSError as error:
            print("shared_session_setup_failed=" + str(error))
    # 权限全自动：沙箱 danger-full-access + 审批 never，微信链路无需人工批准。
    env.setdefault("DSH_PERMISSION_MODE", "danger-full-access")
    # 中文短协议按 config/harnessTuning.json 开关（A/B 实测：输入 -61%）。
    tuning = load_tuning()
    env["DSH_WIRE_ZH"] = "1" if tuning.get("wireZh") else "0"
    print("wire_zh=" + env["DSH_WIRE_ZH"] + " reasoning_off=" + ("1" if tuning.get("reasoningOff") else "0"))
    # 诊断探针：把模型请求摘要与原始流事件写成 JSONL，排查"模型到底回了什么"。
    # 设 DSH_LLM_PROBE_LOG=0 可关闭；默认写到 runtime/llm-probe.log。
    probe_env = os.environ.get("DSH_LLM_PROBE_LOG")
    if probe_env is None:
        env["DSH_LLM_PROBE_LOG"] = str(PROJECT_ROOT / "runtime" / "llm-probe.log")
    elif probe_env.strip() in {"0", "off", "false"}:
        env.pop("DSH_LLM_PROBE_LOG", None)
    else:
        env["DSH_LLM_PROBE_LOG"] = probe_env.strip()
    # 代理：opencode/Codex 这些 Node 工具**不会**自动使用 Windows 系统代理（Clash 的"系统代理"），
    # 必须显式给 HTTP(S)_PROXY，否则访问境外 API 会 ProviderHeaderTimeoutError / Cannot connect。
    # 这里自动探测常见 Clash 端口并注入；已显式设置过则尊重原值；DSH_STACK_PROXY=0 可关闭。
    if os.environ.get("DSH_STACK_PROXY", "").strip() != "0":
        if not env.get("HTTPS_PROXY") and not env.get("https_proxy"):
            proxy = detect_local_proxy()
            if proxy:
                env["HTTPS_PROXY"] = proxy
                env["HTTP_PROXY"] = proxy
                env.setdefault("NO_PROXY", "127.0.0.1,localhost,::1")
                print("proxy_detected=" + proxy)
    # 微信链路诊断日志（compose/agent 轨迹），默认开启便于排查。
    env.setdefault("DSH_WEIXIN_DEBUG_LOG", str(PROJECT_ROOT / "runtime" / "weixin-debug.log"))
    # 微信链路结构化探针（ingress/state/inbound/outbound/lifecycle/turn-context）。
    # 设 DSH_WEIXIN_PROBE_LOG=0 可关闭；默认写到 runtime/weixin-probe.log。
    probe_backend = os.environ.get("DSH_WEIXIN_PROBE_LOG")
    if probe_backend is None:
        env["DSH_WEIXIN_PROBE_LOG"] = str(PROJECT_ROOT / "runtime" / "weixin-probe.log")
    elif probe_backend.strip() in {"0", "off", "false"}:
        env.pop("DSH_WEIXIN_PROBE_LOG", None)
    else:
        env["DSH_WEIXIN_PROBE_LOG"] = probe_backend.strip()
    # SQLite 状态库（delivery/outbox/route/cursor/turn_context/lease 的唯一来源）。
    env.setdefault("DSH_WEIXIN_STATE_DB", str(DSH_HOME / "weixin-state.db"))


def yaml_string(value: str) -> str:
    """把字符串安全地写成 YAML 双引号标量。"""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def detect_local_proxy() -> str | None:
    """探测本机代理端口（Clash 常见 7897/7890，其次 10809/1080）。

    Node 系工具（opencode / codex）不读 Windows 系统代理，只认 HTTP(S)_PROXY；
    漏配的典型症状就是"浏览器能上、脚本连不上"。
    """
    for port in (7897, 7890, 10809, 1080):
        with socket.socket() as probe:
            probe.settimeout(0.4)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return "http://127.0.0.1:%d" % port
    return None


def render_settings(config: dict) -> str:
    """渲染 JSON 到 settings.yaml 的 provider 列表和默认模型。"""
    tuning = load_tuning()
    lines = ["llm-pi-ai:", "  providers:"]
    for name, provider in config.get("providers", {}).items():
        lines.append("    " + name + ":")
        lines.append("      displayName: " + yaml_string(str(provider.get("displayName", name))))
        lines.append("      apiKeyEnv: " + yaml_string(str(provider.get("apiKeyEnv", ""))))
        if provider.get("api"):
            lines.append("      api: " + yaml_string(str(provider["api"])))
        if provider.get("baseURL"):
            lines.append("      baseURL: " + yaml_string(str(provider["baseURL"])))
        # 模型容量：GUI 里改的"上下文窗口"落到这里（harness 用它算压缩阈值）
        if provider.get("defaultContextWindow"):
            lines.append("      defaultContextWindow: " + str(int(provider["defaultContextWindow"])))
        models = provider.get("models") or []
        if models:
            lines.append("      models:")
            for model in models:
                lines.append("        - id: " + yaml_string(str(model.get("id", ""))))
                lines.append("          name: " + yaml_string(str(model.get("name", model.get("id", "")))))
                inputs = model.get("input")
                if inputs:
                    lines.append("          input: [" + ", ".join(yaml_string(str(item)) for item in inputs) + "]")
                if model.get("contextWindow"):
                    lines.append("          contextWindow: " + str(int(model["contextWindow"])))
                # 关思考链：小模型在"聊天/干活"场景里思考经常是空转，关掉后首字更快、输出更少
                if tuning.get("reasoningOff"):
                    lines.append("          reasoning: " + yaml_string("off"))
    default = config.get("defaultModel", {})
    lines.append("agent-default-model:")
    lines.append("  provider: " + yaml_string(str(default.get("provider", ""))))
    lines.append("  model: " + yaml_string(str(default.get("model", ""))))
    return "\n".join(lines) + "\n"


def sync_settings(config: dict) -> None:
    """把 JSON 的 provider/默认模型同步进 settings.yaml，保留其它顶层配置，写入前备份。"""
    existing = ""
    if SETTINGS_FILE.is_file():
        existing = SETTINGS_FILE.read_text(encoding="utf-8")
        backup = SETTINGS_FILE.with_name("settings.yaml.bak-" + time.strftime("%Y%m%d-%H%M%S"))
        shutil.copyfile(SETTINGS_FILE, backup)
    kept: list[str] = []
    skip = False
    for line in existing.splitlines():
        if line and not line[0].isspace() and line.rstrip().endswith(":"):
            skip = line.split(":", 1)[0] in {"llm-pi-ai", "agent-default-model"}
        if not skip:
            kept.append(line)
    head = "\n".join(kept).strip()
    content = (head + "\n" if head else "") + render_settings(config)
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(content, encoding="utf-8")


def opencode_server_reachable() -> bool:
    """探测 opencode server 端口是否已就绪。"""
    with socket.socket() as probe:
        probe.settimeout(1.5)
        return probe.connect_ex(("127.0.0.1", OPENCODE_SERVER_PORT)) == 0


def ensure_opencode_server(env: dict[str, str]) -> str:
    """确保常驻 opencode server 在跑。

    脱离 server 时 `opencode run -s <会话>`（含 --fork）会无限阻塞、不返回；
    经 server（--attach）后同样的续会话调用约 15 秒返回。这里开机即拉起，避免模型踩坑。
    """
    cfg = ServiceRegistry().get_service("opencode")
    if cfg["management"] != "managed":
        return cfg["management"]
    global OPENCODE_SERVER_PORT
    OPENCODE_SERVER_PORT = cfg["port"]
    if opencode_server_reachable():
        return "already_running"
    if not OPENCODE_BIN.is_file():
        return "skipped_bin_missing"
    spawn_silent([str(OPENCODE_BIN), "serve", "--port", str(OPENCODE_SERVER_PORT)],
                 PROJECT_ROOT, env, "opencode-server.log")
    for _ in range(30):
        if opencode_server_reachable():
            return "started"
        time.sleep(1)
    return "started_unverified"


def gemma_local_reachable() -> bool:
    """探测本地 Gemma4 llama-server 是否已就绪。"""
    with socket.socket() as probe:
        probe.settimeout(1.5)
        return probe.connect_ex(("127.0.0.1", GEMMA_SERVER_PORT)) == 0


def gpu_free_mb() -> int | None:
    """读一次显存空闲量（MB）；没有 nvidia-smi 时返回 None。"""
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
        used, total = [int(item.strip()) for item in output.stdout.strip().splitlines()[0].split(",")]
        return total - used
    except Exception:
        return None


def wait_for_gpu_free(min_free_mb: int, timeout_s: int, poll_s: int = 20) -> bool:
    """等显存空出来；超时返回 False。

    为什么在启动器里也等：本地 Gemma 醒来要占约 5.3GB，而这张卡只有 8GB。
    开机时如果用户正在跑游戏/训练，硬拉起来会把两边一起拖垮；
    等一会儿再起是更便宜的选择（链路稍微晚点可用，但不会互相拖死）。
    """
    deadline = time.time() + timeout_s
    announced = False
    while True:
        free = gpu_free_mb()
        if free is None:
            return True  # 探测不到就放行，不能因此永远不启动
        if free >= min_free_mb:
            if announced:
                print("gpu_free_mb=%d（已等到空闲）" % free)
            return True
        if time.time() >= deadline:
            print("gpu_wait_timeout=free_%dMB<need_%dMB" % (free, min_free_mb))
            return False
        if not announced:
            announced = True
            print("gpu_busy=free_%dMB<need_%dMB，等待显存空闲…" % (free, min_free_mb))
        time.sleep(min(poll_s, max(1, int(deadline - time.time()))))


def ensure_gemma_server(env: dict[str, str]) -> str:
    """确保本地 Gemma4 llama-server 在跑。

    只有当默认模型（或任一 provider）指向 127.0.0.1:GEMMA_SERVER_PORT 时才拉起，
    避免用云端模型时白白吃显存。首次加载模型要几十秒，这里最多等 180 秒。
    """
    global GEMMA_SERVER_PORT
    registry = ServiceRegistry()
    cfg = registry.get_service("llm")
    registry.apply_environment(env)
    if cfg["management"] == "external":
        return "external"
    GEMMA_SERVER_PORT = cfg["port"]
    config = load_model_config()
    registry.apply_model_config(config)
    local_needed = cfg.get("provider", "gemma-local") in config.get("providers", {})
    if not local_needed:
        return "not_needed"
    binary = GEMMA_ROOT / "llama.cpp" / "build-ninja" / "bin" / "llama-server.exe"
    model = GEMMA_ROOT / "gemma4E4B" / "model" / "gemma-4-E4B-it-Q4_K_M.gguf"
    mmproj = GEMMA_ROOT / "gemma4E4B" / "model" / "mmproj-BF16.gguf"
    # 把解析好的路径注入 harness 环境：运行期需要"按需补拉"时直接用，
    # 免得它在那边再猜一遍路径（两处各猜一次必然漂移）。
    env["GEMMA_SERVER_BIN"] = str(binary)
    env["GEMMA_MODEL_PATH"] = str(model)
    env["GEMMA_MMPROJ_PATH"] = str(mmproj) if mmproj.is_file() else ""
    env["GEMMA_SERVER_PORT"] = str(GEMMA_SERVER_PORT)
    env["GEMMA_ROOT"] = str(GEMMA_ROOT)

    if gemma_local_reachable():
        return "already_running"
    # 拉起来之前先确认显存够（等不到就先不起；运行期还会再等一次并自动补拉）。
    min_free = int(os.environ.get("DSH_GEMMA_MIN_FREE_VRAM_MB") or "5200")
    wait_s = int(os.environ.get("DSH_GEMMA_VRAM_WAIT_S") or "300")
    if not wait_for_gpu_free(min_free, wait_s):
        return "skipped_gpu_busy"
    if not binary.is_file() or not model.is_file():
        return "skipped_missing_files"
    # -c 32768：harness 的系统提示 + 工具目录本身就要 1.4 万 token，8192 会直接报
    # CONTEXT_WINDOW_EXCEEDED；32K 在 8GB 显存上约用 4.2GB（含模型 3.8GB）。
    # -fa on 开 flash attention 压低 KV cache 占用；显存不够就调小 -c。
    # --sleep-idle-seconds：空闲这么久后自动休眠释放显存，下次请求自动唤醒。
    # 实测：常驻占 4.4GB；空闲 90s 后降到 0.8GB（释放约 3.6GB）；唤醒约 17.6s。
    # 时间线摘要是"几小时一次"的低频任务，所以让它平时不占显存是划算的。
    # 值要大于单次摘要的耗时（含分块 map-reduce 的多次请求间隔），默认 120s。
    sleep_idle = os.environ.get("DSH_GEMMA_SLEEP_IDLE_SECONDS") or "120"
    args = [str(binary), "-m", str(model), "--host", "127.0.0.1", "--port", str(GEMMA_SERVER_PORT),
            "-c", "32768", "-ngl", "99", "--jinja", "--reasoning", "off", "-np", "1", "-fa", "on",
            "--alias", str(cfg["model"]), "--sleep-idle-seconds", str(sleep_idle)]
    # 视觉投影器：加载后 Gemma 才能看图，用于"图片一句话描述"（写进时间线）。
    # 不加载它就只能处理纯文本。代价：+946MB 显存，且休眠时同样会被释放。
    if mmproj.is_file():
        args += ["--mmproj", str(mmproj)]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    # 给 llama-server **自己的日志文件**：以前它的输出直接继承父进程句柄，
    # 结果"Gemma 到底有没有正常起来"只能靠端口探测猜（这次查昨晚状态时就吃了这个亏）。
    gemma_log = PROJECT_ROOT / "runtime" / "gemma-server.log"
    gemma_log.parent.mkdir(parents=True, exist_ok=True)
    try:
        with gemma_log.open("ab") as handle:
            subprocess.Popen(args, cwd=str(binary.parent), env=env, creationflags=flags,
                             stdin=subprocess.DEVNULL, stdout=handle, stderr=handle)
    except OSError:
        # 日志文件打不开也不能挡住启动本身
        subprocess.Popen(args, cwd=str(binary.parent), env=env, creationflags=flags)
    for _ in range(180):
        if gemma_local_reachable():
            return "started"
        time.sleep(1)
    return "started_unverified"


def check_weixin_token(config: dict) -> tuple[str, str]:
    """用一次轻量请求探活微信 iLink token。

    只调 notifystart（不发送消息、不影响会话），判断凭据是否还能用。
    注意：notifystart 能过**不代表**发送能过（实测 token 失效时它仍返回 ret:0），
    所以这里只把明确的鉴权失败当作"失效"，真正的失效检测放在运行期的 ret=-2 上报。

    @returns (状态, 说明)；状态取值：ok / invalid / unreachable / skipped
    """
    weixin = config.get("weixin", {})
    token = weixin.get("token")
    if not token:
        return "skipped", "配置里没有 weixin.token"
    base = str(weixin.get("baseURL") or "https://ilinkai.weixin.qq.com").rstrip("/")
    payload = json.dumps({"base_info": {"channel_version": "dsh-stack-check", "bot_agent": "DeepSeekHarness"}}).encode("utf-8")
    request = urllib.request.Request(
        base + "/ilink/bot/msg/notifystart",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + str(token),
                 "AuthorizationType": "ilink_bot_token", "X-WECHAT-UIN": "c3RhY2s="},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8", "ignore"))
    except Exception as error:  # noqa: BLE001
        return "unreachable", str(error)
    ret = body.get("ret")
    if ret in (0, None):
        # 服务端 on 线不代表发送可用：运行期若记过 ret=-2，以那个更可靠的信号为准。
        marker = TOKEN_INVALID_FLAG
        if marker.is_file():
            detail = marker.read_text(encoding="utf-8", errors="ignore").strip().splitlines()[-1:]
            return "invalid", "运行期记录到发送被拒（%s）" % (detail[0] if detail else "ret=-2")
        return "ok", "notifystart ret=0"
    return "invalid", "notifystart 返回 %s：%s" % (ret, body.get("errmsg"))


def spawn_silent(command: list[str], cwd: Path, env: dict[str, str], log_name: str) -> subprocess.Popen:
    """静默启动一个后台进程：不弹任何窗口，输出重定向到 runtime/<log_name>。

    窗口版启动容易被误关（一关就整个服务没了），所以统一走隐藏窗口 + 日志落盘。
    日志可用于排查；窗口只在"需要人工操作"时保留（例如微信扫码登录）。
    """
    log_path = PROJECT_ROOT / "runtime" / log_name
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(log_path, "a", encoding="utf-8", errors="replace")
    handle.write("\n===== %s 启动 =====\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
    handle.flush()
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    return subprocess.Popen(command, cwd=str(cwd), env=env, creationflags=flags,
                            stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)


# 活跃源码里必须存在的"新架构"目录。历史上有过两份极易混淆的 harness 副本
# （微信Harness链路\deepseek-harness、微信Harness链路\connector），改错副本会
# "看着改好了但不生效"。这里用新架构目录做指纹：指向旧副本时直接拒绝启动。
REQUIRED_SOURCE_MARKERS = (
    Path("packages") / "webhook" / "webhook-weixin" / "src" / "coordination",
    Path("packages") / "webhook" / "webhook-weixin" / "src" / "state",
    Path("packages") / "webhook" / "webhook-weixin" / "src" / "transport",
)


def verify_harness_source() -> None:
    """启动前钉死"真实执行路径"，fail-closed：指向旧副本/残缺源码就拒绝启动。"""
    if not HARNESS_ROOT.is_dir():
        raise FileNotFoundError("harness 源码目录不存在: " + str(HARNESS_ROOT))
    missing = [str(m) for m in REQUIRED_SOURCE_MARKERS if not (HARNESS_ROOT / m).is_dir()]
    if missing:
        raise RuntimeError(
            "harness 源码疑似旧副本/残缺（缺少新架构目录: " + ", ".join(missing) + "）\n"
            + "  实际路径: " + str(HARNESS_ROOT) + "\n"
            + "  唯一可用源码应为: <智能秘书>\\deepseek-harness，请勿指向备份或 *removed* 目录。"
        )
    # 游离副本告警：只提示，不阻断（它们不参与运行）。
    stray = [p.name for p in PROJECT_ROOT.glob("deepseek-harness*")
             if p.is_dir() and p.resolve() != HARNESS_ROOT.resolve()]
    stray += [p.name for p in PROJECT_ROOT.glob("connector*") if p.is_dir()]
    if stray:
        print("WARNING: 项目内存在未使用的 harness 副本（勿修改，实际运行的是 "
              + str(HARNESS_ROOT) + "）: " + ", ".join(sorted(stray)))


def start_harness_service(env: dict[str, str]) -> subprocess.Popen:
    """启动 DeepSeek Harness 微信后台服务（静默、无窗口，日志进 runtime/harness-run.log）。"""
    command = ["powershell.exe", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(HARNESS_SCRIPT)]
    return spawn_silent(command, HARNESS_ROOT, env, "harness-run.log")


# ── 单实例 / 自愈 ─────────────────────────────────────────────────────────────
# 自启动最容易踩的两个坑，全在这里兜住：
#   1. 上一次进程被强杀后 consumer_lease 还留着它的 pid → 新实例被"已有消费者"挡回；
#   2. 守护/手动/自启动同时拉起 → 两个实例互抢 lease 与端口，谁都起不来。
LOCK_FILE = PROJECT_ROOT / "runtime" / "stack.lock"
HARNESS_PORT = int(os.environ.get("DSH_HARNESS_PORT") or "3080")
HARNESS_INJECT_PORT = int(os.environ.get("DSH_WEIXIN_INJECT_PORT") or "3081")
STATE_DB = DSH_HOME / "weixin-state.db"


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 1.2) -> bool:
    """探测本机端口是否有进程在监听（只看"能不能连上"，不发任何业务请求）。"""
    with socket.socket() as probe:
        probe.settimeout(timeout)
        return probe.connect_ex((host, port)) == 0


def process_alive(pid: int) -> bool:
    """判断 pid 是否还活着（用 tasklist，避免 psutil 依赖）。"""
    if pid <= 0:
        return False
    try:
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
        )
        return str(pid) in (result.stdout or "")
    except (OSError, subprocess.SubprocessError):
        return False


_STACK_HANDLE = None


def acquire_lock() -> bool:
    """无参数；持有操作系统文件锁至启动结束，关闭“先读 PID 再写入”的并发窗口。"""
    global _STACK_HANDLE
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    handle = LOCK_FILE.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()).encode("ascii"))
        handle.flush()
    except OSError:
        handle.close()
        print("stack_lock=held，本次不重复启动")
        return False
    _STACK_HANDLE = handle
    return True


def release_lock() -> None:
    """无参数；关闭持锁句柄；保留锁文件，避免另一个进程等待期间锁路径被替换。"""
    global _STACK_HANDLE
    if _STACK_HANDLE is not None:
        _STACK_HANDLE.close()
        _STACK_HANDLE = None


def kill_orphan_harness() -> None:
    """无参数；复用严格进程识别清理孤儿，不按任意命令文本匹配维护工具。"""
    try:
        from tools.stop_stack import kill_harness
        if kill_harness():
            time.sleep(2)
    except (OSError, subprocess.SubprocessError):
        pass


def clear_stale_lease() -> None:
    """清掉指向"已死进程"的 consumer_lease（只删死记录，活着的实例绝不动）。"""
    if not STATE_DB.exists():
        return
    try:
        import sqlite3

        connection = sqlite3.connect(str(STATE_DB), timeout=8)
        try:
            row = connection.execute("SELECT pid, owner_id FROM consumer_lease WHERE id = 1").fetchone()
            if row is not None and not process_alive(int(row[0] or 0)):
                connection.execute("DELETE FROM consumer_lease WHERE id = 1")
                connection.commit()
                print(f"lease_cleared=pid:{row[0]}（持有者已不在）")
        finally:
            connection.close()
    except Exception as error:  # noqa: BLE001 —— 清理失败不该阻塞启动
        print(f"lease_cleanup_failed={error}")


def clear_stuck_deliveries() -> None:
    """把重启时卡在 routing 的投递标记为终态，避免游标被永久扣住。

    背景：微信入站协调器只有在投递到达终态后才提交游标；如果 harness 在
    "routing" 阶段被重启，重启后没人收尾，后续消息就永远进不来。
    """
    if not STATE_DB.exists():
        return
    try:
        import sqlite3

        connection = sqlite3.connect(str(STATE_DB), timeout=8)
        try:
            rows = connection.execute(
                "SELECT delivery_id FROM delivery WHERE status = 'routing'"
            ).fetchall()
            if rows:
                connection.execute(
                    "UPDATE delivery SET status = 'failed_terminal', "
                    "last_error = 'stuck in routing before restart (auto recover)' "
                    "WHERE status = 'routing'"
                )
                connection.commit()
                print(f"deliveries_released={len(rows)}（卡在 routing，已标记终态释放游标）")
        finally:
            connection.close()
    except Exception as error:  # noqa: BLE001 —— 清理失败不该阻塞启动
        print(f"delivery_cleanup_failed={error}")


def ensure_reminder_service(env: dict[str, str]) -> str:
    """确保独立提醒服务常驻（每 30 秒轮询、到点 QQ 直推）。"""
    from microServices.ServiceManager import ServiceManager
    cfg = ServiceRegistry().get_service("reminders")
    if cfg["management"] != "managed":
        return cfg["management"]
    ServiceManager(PROJECT_ROOT).ensure_service("reminders")
    return "microservice_ready"


def ensure_rsshub(env: dict[str, str]) -> str:
    """确保本机 RSSHub（端口 1200）在跑；没起就后台拉一个。"""
    cfg = ServiceRegistry().get_service("rsshub")
    if cfg["management"] != "managed":
        return cfg["management"]
    rsshub_dir = PROJECT_ROOT / "rsshub" / "RSSHub"
    pid_file = PROJECT_ROOT / "runtime" / "rsshub.pid"
    if port_open(cfg["port"]):
        return "already_running"
    entry = rsshub_dir / "dist" / "index.mjs"
    if not entry.is_file():
        return "missing_build"
    node = r"C:\Program Files\nodejs\node.exe"
    for candidate in (r"E:\project_make\nodejs\node.exe", "node"):
        if candidate == "node" or Path(candidate).is_file():
            node = candidate
            break
    child_env = dict(env)
    child_env["PORT"] = str(cfg["port"])
    child_env["NODE_ENV"] = "production"
    child_env["NODE_OPTIONS"] = "--max-http-header-size=32768"
    process = spawn_silent([node, str(entry)], rsshub_dir, child_env, "rsshub.log")
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(process.pid), encoding="utf-8")
    for _ in range(40):
        time.sleep(0.5)
        if port_open(cfg["port"]):
            return "started"
    return "start_failed"


def ensure_guard_service(env: dict[str, str]) -> str:
    """确保链路兜底巡检常驻（每 60 秒：释放卡住投递、清死租约、检查 QQ 网关、补跑技能复盘）。

    注意日志分两个文件：
    - 巡检**自己写的**结论 → runtime/guard-service.log（带时间戳、可 grep）；
    - 进程的 stdout/stderr → runtime/guard-service.console.log。
    两者绝不能是同一个文件：两个句柄写同一份文件，轻则每行重复两遍，
    重则像 2026-10-29 03:00 那次一样直接 PermissionError 把进程带崩。
    """
    pid_file = PROJECT_ROOT / "runtime" / "guard.pid"
    if pid_file.is_file():
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
            if process_alive(pid):
                return "already_running"
        except (OSError, ValueError):
            pass
    process = spawn_silent(
        [sys.executable, str(PROJECT_ROOT / "tools" / "guardService.py"), "--loop"],
        PROJECT_ROOT, env, "guard-service.console.log",
    )
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(process.pid), encoding="utf-8")
    return "started"


def wait_harness_ready(seconds: int = 120, startup=None) -> bool:
    """等 3080/3081 两个端口就绪；超时返回 False（自启动据此判断要不要重试）。"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if startup is not None and startup.was_stopped():
            return False
        if port_open(HARNESS_PORT) and port_open(HARNESS_INJECT_PORT):
            return True
        time.sleep(2)
    return False



def main() -> int:
    """从 JSON 加载配置、注入环境并同步 settings，然后启动后台服务。"""
    core = ServiceRegistry().get_service("core")
    if core["management"] == "external":
        from microServices.ServiceManager import ServiceManager
        ServiceManager(PROJECT_ROOT).ensure_service("core")
        print("core=external；仅使用远程核心，未启动本机消费者或守护")
        return 0
    if core["management"] == "disabled":
        print("core=disabled")
        return 0
    startup = StartupState(PROJECT_ROOT)
    startup.record_stage("requested")
    if not HARNESS_SCRIPT.exists():
        raise FileNotFoundError("启动文件不存在: " + str(HARNESS_SCRIPT))
    # 幂等：已经在跑就直接返回，避免守护/自启动/手动同时拉起造成多实例互抢
    if port_open(HARNESS_PORT) and port_open(HARNESS_INJECT_PORT):
        startup.complete_start()
        startup.record_stage("already_ready")
        print(f"already_running ports={HARNESS_PORT},{HARNESS_INJECT_PORT}，跳过启动")
        return 0
    # 没有健康实例时才清理残留：孤儿进程 + 死进程留下的 lease
    kill_orphan_harness()
    clear_stale_lease()
    clear_stuck_deliveries()
    verify_harness_source()
    print("harness_source=" + str(HARNESS_ROOT))
    config = load_model_config()
    env = os.environ.copy()
    apply_environment(config, env)
    remember_python_for_console()
    console_keys = load_console_env(env)
    # 控制台环境只提供密钥等补充项；端点和生命周期仍由注册表统一决定。
    ServiceRegistry().apply_environment(env)
    ServiceRegistry().apply_model_config(config, env)
    if console_keys:
        print("console_env_applied=" + ",".join(console_keys))
    sync_settings(config)
    secret_count, shadowed = sync_credentials(config)
    if shadowed:
        print("WARNING: 以下凭据名已存在于当前环境变量，会遮蔽 JSON 里的值（请清掉环境变量后重启）："
              + ", ".join(shadowed))
    print("credentials_synced=" + str(CREDENTIALS_FILE) + " refs=" + str(secret_count))
    env.setdefault("OPENCODE_SERVER_URL", OPENCODE_SERVER_URL)
    env.setdefault("OPENCODE_BIN", str(OPENCODE_BIN))
    startup.record_stage("config_ready")
    # 云端对话不等待本地显存。仅当默认对话确实使用本地模型时同步准备LLM；
    # 记忆维护等低频本地推理由Harness既有按需机制处理。
    llm = ServiceRegistry().get_service("llm")
    if (llm["management"] == "managed" and
            config.get("defaultModel", {}).get("provider") == llm.get("provider", "gemma-local")):
        print("llm=" + ensure_gemma_server(env))
    if startup.was_stopped():
        startup.record_stage("cancelled")
        return 1
    # 不在启动前调用notifystart或消费历史token告警；真实鉴权交给唯一通道消费者。
    harness = start_harness_service(env)
    startup.record_stage("harness_spawned")
    print("config=" + str(CONFIG_JSON))
    print("settings_synced=" + str(SETTINGS_FILE))
    print("dsh_harness_pid=" + str(harness.pid))
    print("harness service started (silent, log=runtime/harness-run.log)")
    # 等真正就绪再返回：自启动脚本/守护据此判断成功与否（失败会重试，而不是"看起来启动了"）
    if wait_harness_ready(120, startup) and not startup.was_stopped():
        startup.complete_start()
        startup.record_stage("core_ready")
        print("optional_services_pid=" + str(StartupServices(PROJECT_ROOT).detach_start(env)))
        print("harness_ready=1")
        return 0
    startup.record_stage("cancelled" if startup.was_stopped() else "core_timeout")
    print("harness_ready=0（120 秒内 3080/3081 未就绪，详见 runtime/harness-run.log）")
    return 1


if __name__ == "__main__":
    if not acquire_lock():
        raise SystemExit(0)
    try:
        raise SystemExit(main())
    finally:
        release_lock()
