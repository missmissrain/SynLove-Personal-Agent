/**
 * 任务失败信息：从真实终态提取错误码与原因，脱敏后用于持久化和结果通知。
 * 注册参数无；默认正文最多1000字符，未知错误使用TASK_RUNTIME_ERROR，不伪造HTTP状态码。
 */
export class TaskFailure {
  /** value为异常或内核错误对象，fallback为宿主错误码；返回可安全回传的错误信息。 */
  normalize_error(value: any, fallback = 'TASK_RUNTIME_ERROR'): any {
    const raw = value?.message ?? (typeof value === 'string' ? value : '后台执行异常，未提供详细原因')
    const message = String(raw)
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[a-z0-9_-]{8,}/gi, '[REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[服务地址已隐藏]')
      .slice(0, 1000)
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(value?.code ?? '') ? value.code : fallback
    return { code, message }
  }

  /** reason为turn/end的真实原因；仅处理内核error终态，不把取消或成功误判为模型失败。 */
  from_reason(reason: any): any {
    if (reason?.kind !== 'error' && reason !== 'error') return undefined
    return this.normalize_error(reason?.error ?? reason?.failure)
  }

  /** failure为脱敏后的错误；形成可持久化的短字符串，空值返回null。 */
  describe_error(failure: any): string | null {
    return failure ? `${failure.code}: ${failure.message}` : null
  }

  /** text为润色后的通知，error为持久化错误；确保已知错误码不被自然语言润色省略。 */
  ensure_code(text: string, error: any): string {
    const code = typeof error === 'string' ? error.match(/^([A-Z][A-Z0-9_]{0,79}):/)?.[1] : undefined
    return code && !text.includes(code) ? `${text}（错误码：${code}）` : text
  }
}
