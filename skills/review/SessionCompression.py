"""会话压缩适配器：优先复用 Python zstandard，缺失时使用现有 Node 的 Zstandard。参数：CONSOLE_NODE 可指定 Node 24 路径。"""
import os
import shutil
import subprocess
from pathlib import Path


class SessionCompression:
    """保持复盘读取与 Harness 压缩格式兼容，不在运行时安装依赖。"""

    @staticmethod
    def decompress_bytes(raw):
        """raw 为 Zstandard 压缩字节；返回解压字节，读取失败抛错以保留水位。"""
        try:
            import zstandard
        except ImportError:
            node = os.environ.get("CONSOLE_NODE") or shutil.which("node")
            if not node:
                raise RuntimeError("技能复盘需要 zstandard 或支持 Zstandard 的 Node 24")
            module = Path(__file__).resolve().parents[2] / "backend/packages/session/session-persistence-jsonl/lib/types/zstd.js"
            script = (
                "import {readFileSync} from 'node:fs';"
                "import {pathToFileURL} from 'node:url';"
                "import {zstdDecompressSync} from 'node:zlib';"
                "const {scanZstdFrames}=await import(pathToFileURL(process.argv[1]).href);"
                "const raw=readFileSync(0);const {frames,tornStart}=scanZstdFrames(raw);"
                "if(tornStart!==undefined)throw Error('incomplete session frame');"
                "for(const f of frames)process.stdout.write(zstdDecompressSync(raw.subarray(f.start,f.end)));"
            )
            result = subprocess.run(
                [node, "--input-type=module", "-e", script, str(module)],
                input=raw, capture_output=True, timeout=30,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode:
                raise RuntimeError("Node 会话解压失败，请核对版本及会话完整性")
            return result.stdout
        with zstandard.ZstdDecompressor().stream_reader(raw) as reader:
            return reader.read()
