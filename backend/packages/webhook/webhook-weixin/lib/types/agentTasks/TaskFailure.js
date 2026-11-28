export class TaskFailure {
    normalize_error(value, fallback = 'TASK_RUNTIME_ERROR') {
        const raw = value?.message ?? (typeof value === 'string' ? value : '后台执行异常，未提供详细原因');
        const message = String(raw).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\bsk-[a-z0-9_-]{8,}/gi, '[REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]').replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址已隐藏]').slice(0, 1000);
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(value?.code ?? '') ? value.code : fallback;
        return {
            code,
            message
        };
    }
    from_reason(reason) {
        if (reason?.kind !== 'error' && reason !== 'error') return undefined;
        return this.normalize_error(reason?.error ?? reason?.failure);
    }
    describe_error(failure) {
        return failure ? `${failure.code}: ${failure.message}` : null;
    }
    ensure_code(text, error) {
        const code = typeof error === 'string' ? error.match(/^([A-Z][A-Z0-9_]{0,79}):/)?.[1] : undefined;
        return code && !text.includes(code) ? `${text}（错误码：${code}）` : text;
    }
}
