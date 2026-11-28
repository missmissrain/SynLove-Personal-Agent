"""日志证据脱敏：供固定自修脚本和守护器共同使用，不读取凭据文件。

注册参数无；覆盖 Bearer、密钥字段、连接地址、邮箱和 Windows 用户目录，返回有界调用方可再截断。
"""
import re


class LogRedactor:
    """在提交编码器之前删除日志中的凭据与个人网络标识。"""

    @staticmethod
    def redact_text(text):
        """text 为任意日志正文；返回脱敏文本，不保留令牌、地址或账号原值。"""
        value = str(text or "")
        value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
        value = re.sub(r"(?i)([\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|"
                       r"password|passwd|client[_-]?secret|authorization|cookie|set-cookie)[\"']?"
                       r"\s*[:=]\s*)([\"']?)[^\s,\"';}\r\n]+",
                       r"\1[REDACTED]", value)
        value = re.sub(r"https?://(?:[^/@\s]+@)?[^/\s?#]+", "https://[HOST]", value, flags=re.I)
        value = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[IP]", value)
        value = re.sub(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", "[EMAIL]", value)
        value = re.sub(r"(?i)([A-Z]:[\\/]+Users[\\/]+)[^\\/\s]+", r"\1[USER]", value)
        value = re.sub(r"(?i)\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}", "[KEY]", value)
        return value
