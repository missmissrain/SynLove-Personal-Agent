/**
 * 微信链路诊断探针：把入站/状态/出站三个状态机的关键跃迁写成结构化 JSONL，
 * 便于事后回答"这条消息走到哪一步、卡在哪、为什么没回复"。
 *
 * 与 llm 探针（DSH_LLM_PROBE_LOG）分工：
 * - llm 探针：模型请求与原始流事件；
 * - 本探针：微信协议、状态机、outbox、lease。
 *
 * 仅在设置 `DSH_WEIXIN_PROBE_LOG`（文件路径）时生效；探针写入失败绝不影响主流程。
 * @module dsh-webhook-weixin/probe
 */

import { appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

/**
 * 观测记录器：只有工作区装好 `@deepseek-ai/dsh-llm` 时才可用。
 * 发版门槛在干净检出里跑回归，没有 node_modules；探针不能因此让整个模块导入失败，
 * 所以这里改成同步按需加载，拿不到就只写本地 JSONL，不写 trace。
 */
interface ObservationRecorderLike {
  outbound_context(id: string): { traceId: string; spanId: string } | undefined
  turn_context(session_id: string, turn: number): { traceId: string; spanId: string } | undefined
  current(session_id: string): { traceId: string; spanId: string } | undefined
  emit(event: Record<string, unknown>): void
}

const observation_recorder: ObservationRecorderLike | undefined = (() => {
  try {
    const loaded = createRequire(import.meta.url)('@deepseek-ai/dsh-llm') as { ObservationRecorder?: ObservationRecorderLike }
    return loaded.ObservationRecorder
  } catch {
    return undefined
  }
})()

/** 解析探针日志路径；未配置返回 undefined。 */
function probe_path(): string | undefined {
  const path = process.env.DSH_WEIXIN_PROBE_LOG
  return path !== undefined && path.length > 0 ? path : undefined
}

/** 探针是否启用。 */
export function probe_enabled(): boolean {
  return probe_path() !== undefined
}

/**
 * 追加一条探针记录。
 * @param scope - 子系统名：ingress / state / inbound / outbound / lifecycle / turn-context。
 * @param event - 事件名，如 delivery.received / outbox.sent。
 * @param fields - 结构化字段；值会被安全序列化并截断。
 */
export function probe(scope: string, event: string, fields?: Record<string, unknown>): void {
  const path = probe_path()
  if (path === undefined) return
  const session_id = typeof fields?.session_id === 'string' ? fields.session_id : undefined
  const trace = observation_recorder === undefined ? undefined
    : typeof fields?.outbound_id === 'string' ? observation_recorder.outbound_context(fields.outbound_id)
    : session_id === undefined ? undefined : typeof fields?.turn === 'number'
    ? observation_recorder.turn_context(session_id, fields.turn) : observation_recorder.current(session_id)
  if (trace !== undefined && !event.startsWith('poll.')) {
    observation_recorder?.emit({
      traceId: trace.traceId, parentSpanId: trace.spanId, sessionId: session_id,
      kind: 'transport', phase: 'event', name: `${scope}.${event}`,
      deliveryId: fields?.delivery_id, outboxId: fields?.outbound_id,
      outcome: fields?.outcome, durationMs: fields?.duration_ms,
    })
  }
  const record = {
    at: new Date().toISOString(),
    scope,
    event,
    ...fields === undefined ? {} : { data: sanitize(fields) },
  }
  void appendFile(path, JSON.stringify(record) + '\n', 'utf8').catch(() => undefined)
}

/** 计时器：`const done = probe_timer('scope','event',{...}); ... done({extra})`。 */
export function probe_timer(scope: string, event: string, fields?: Record<string, unknown>): (extra?: Record<string, unknown>) => void {
  const started = Date.now()
  return extra => probe(scope, event, { ...fields, ...extra, duration_ms: Date.now() - started })
}

/** 截断长字符串、限制数组长度，保证探针日志不会自我爆炸。 */
function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 400 ? value.slice(0, 400) + `…(+${value.length - 400})` : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map(item => sanitize(item, depth + 1))
    return value.length > 20 ? [...head, `…(+${value.length - 20})`] : head
  }
  if (typeof value === 'object') {
    if (depth > 3) return '[deep]'
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = sanitize(item, depth + 1)
    return out
  }
  return String(value)
}
