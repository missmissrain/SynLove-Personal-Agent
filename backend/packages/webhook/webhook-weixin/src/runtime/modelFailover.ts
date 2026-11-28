/**
 * 模型故障转移：某个 API 失活（额度用完 / key 失效 / 模型下线）时，
 * 自动换到系统里配置的**另一个** API 继续干活。
 *
 * ## 为什么需要
 *
 * 实测踩过：中转站的 key 用满 7 天额度后，每一次模型调用都 429，这一轮直接失败——
 * 用户看到的是"一直处理中"然后什么都没有。系统里明明还配着豆包、千问的 key，
 * 却只能靠人手动去控制台换。这个模块就是让"换"自动发生。
 *
 * ## 怎么换（不丢上下文、不重启）
 *
 * harness 的 `sessionController.selectModel({sessionId, provider, model})` 会把选择装到
 * **下一个请求**上，并顺手保存成默认值——所以同一段对话可以无缝换模型。
 * 本模块只负责"判断该不该换、换成谁、多久内别再试它"，副作用由连接器执行。
 *
 * ## 判定
 *
 * 只有**重试也没用**的错误才换：额度/限流、鉴权失败、模型不存在。
 * 网络抖动、5xx 这类交给 harness 自己的重试策略（llm-retry），我们不要抢着换。
 *
 * @module dsh-webhook-weixin/model-failover
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 失活原因。 */
export type FailoverReason = 'quota' | 'rate_limit' | 'auth' | 'model_missing'

/**
 * 找到模型配置文件的真实路径。
 *
 * 它在**工作区的 `config/` 子目录**下（`<工作区>/config/modelConfig.json`）。
 * 早先按 `<工作区>/modelConfig.json` 找过——读不到就静默变成空配置，
 * 表现是"故障转移明明配了却说没有候选模型"（2026-09-22 实测踩过）。
 *
 * @param workspace - 工作区目录（连接器里的 PROJECT_CONFIG_DIR）。
 * @returns 存在的那个路径；都不存在返回 undefined。
 */
export function find_model_config(workspace: string): string | undefined {
  const candidates = [join(workspace, 'config', 'modelConfig.json'), join(workspace, 'modelConfig.json')]
  return candidates.find(path => existsSync(path))
}

/** 一个候选模型。 */
export interface ModelCandidate {
  readonly provider: string
  readonly model: string
}

/** 解析后的故障转移配置。 */
export interface FailoverConfig {
  readonly enabled: boolean
  /** 候选顺序（含当前默认模型；按顺序找第一个"活着"的）。 */
  readonly order: readonly ModelCandidate[]
  /** 额度类失活的冷却时间（毫秒）；鉴权/模型不存在固定更长。 */
  readonly cooldown_ms: number
}

/** 默认冷却：额度类 1 小时（日额度/滚动窗口有机会恢复），鉴权类 24 小时。 */
const DEFAULT_COOLDOWN_MS = 60 * 60_000
const AUTH_COOLDOWN_MS = 24 * 60 * 60_000
/** 限流/并发类只冷几秒到几分钟——上游一空就能用，别把好模型长期晾着。 */
const RATE_LIMIT_COOLDOWN_MS = 3 * 60_000

/** 这些 provider 是"本地/记忆"用途，不该被当成聊天模型的转移目标。 */
const NON_CHAT_PROVIDERS = new Set(['gemma-local'])

/**
 * 判断一条模型错误是不是"这个 API 不能用了"。
 *
 * @param message - 错误文本（含 HTTP 状态码与上游 message）。
 * @returns 失活原因；不是致命错误就返回 undefined（交给 harness 重试）。
 */
export function classify_llm_failure(message: string): FailoverReason | undefined {
  const text = message.toLowerCase()
  // ① 额度类**先判**：它的类型名里也常带 `rate_limit_exceeded`，
  //    若先判限流就会被误当成"几秒后就好"，把该等一小时的额度问题当成抖动。
  if (/限额|额度|quota|insufficient|欠费|余额不足/.test(text)) {
    return 'quota'
  }
  // ② 瞬时限流：并发满、过载、429。上游常以 403 返回，**必须排在鉴权前面判**，
  //    否则一个几秒后就能用的模型会被当成"key 失效"拉黑很久（实测原文：
  //    `HTTP 403: You've reached your concurrent request limit`）。
  if (/concurrent|too many requests|overload|temporarily unavailable|请稍后重试|并发|繁忙|(^|[^0-9])429([^0-9]|$)/
    .test(text)) {
    return 'rate_limit'
  }
  // 鉴权：401/403、key 无效/失效、unauthorized
  if (/(^|[^0-9])40[13]([^0-9]|$)|unauthorized|forbidden|invalid.?api.?key|api.?key.*(invalid|无效|失效|不正确)|鉴权|认证失败|token.*(invalid|无效|过期)/
    .test(text)) {
    return 'auth'
  }
  // 模型不存在 / 已下线
  if (/(^|[^0-9])404([^0-9]|$)|model.*not.*found|no such model|does not exist|模型不存在|模型已下线/.test(text)) {
    return 'model_missing'
  }
  return undefined
}

/** 冷却时间：限流最短、额度类用配置值、鉴权/模型缺失最长。 */
export function cooldown_ms(reason: FailoverReason, config: FailoverConfig): number {
  if (reason === 'rate_limit') return RATE_LIMIT_COOLDOWN_MS
  return reason === 'quota' ? config.cooldown_ms : AUTH_COOLDOWN_MS
}

/** 从 modelConfig.json 的内容解析故障转移配置。 */
export function parse_failover_config(config: {
  providers?: Record<string, { apiKey?: string, models?: Array<{ id?: string }> }>
  failover?: { enabled?: boolean, order?: Array<{ provider?: string, model?: string }>, cooldownMs?: number }
  defaultModel?: { provider?: string, model?: string }
}): FailoverConfig {
  const raw = config.failover ?? {}
  const enabled = raw.enabled !== false
  const cooldown = Number(raw.cooldownMs)
  // 显式顺序也要**核对确实存在**：删掉某个 provider 之后，链子里可能还指着它，
  // 一旦触发转移就会去解析一个不存在的模型、直接失败（比"少一个候选"糟得多）。
  const known = (provider: string, model: string): boolean => {
    const entry = (config.providers ?? {})[provider]
    if (entry === undefined) return false
    return (entry.models ?? []).some(item => item.id === model)
  }
  const explicit: ModelCandidate[] = (raw.order ?? [])
    .filter(item => typeof item?.provider === 'string' && typeof item?.model === 'string'
      && item.provider !== '' && item.model !== '')
    .map(item => ({ provider: String(item.provider), model: String(item.model) }))
    .filter(item => known(item.provider, item.model))

  // 显式顺序优先；没写就从"默认模型 + 所有配了 key 的模型"推导一个顺序
  const derived: ModelCandidate[] = []
  const push = (candidate: ModelCandidate): void => {
    if (derived.some(item => item.provider === candidate.provider && item.model === candidate.model)) return
    derived.push(candidate)
  }
  const default_model = config.defaultModel
  if (default_model?.provider !== undefined && default_model?.model !== undefined) {
    push({ provider: default_model.provider, model: default_model.model })
  }
  for (const [provider, entry] of Object.entries(config.providers ?? {})) {
    if (NON_CHAT_PROVIDERS.has(provider)) continue
    if (entry.apiKey === undefined || entry.apiKey === '') continue
    for (const model of entry.models ?? []) {
      if (typeof model.id === 'string' && model.id !== '') push({ provider, model: model.id })
    }
  }
  const order = explicit.length > 0 ? explicit : derived
  return {
    enabled,
    order,
    cooldown_ms: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : DEFAULT_COOLDOWN_MS,
  }
}

/** 下一个候选：从 `current` 之后顺着找，跳过失活的（不回头，避免来回横跳）。 */
export function next_alive_candidate(
  order: readonly ModelCandidate[],
  current: ModelCandidate | undefined,
  is_dead: (candidate: ModelCandidate) => boolean,
): ModelCandidate | undefined {
  const start = current === undefined
    ? 0
    : Math.max(0, order.findIndex(item => item.provider === current.provider && item.model === current.model) + 1)
  for (let index = start; index < order.length; index += 1) {
    const candidate = order[index]!
    if (!is_dead(candidate)) return candidate
  }
  // 后面都不可用：从前面再扫一遍（万一只是顺序里排在当前之前的那几个还活着）
  for (let index = 0; index < start && index < order.length; index += 1) {
    const candidate = order[index]!
    if (!is_dead(candidate)) return candidate
  }
  return undefined
}

/** 失活记录。 */
export interface DeadEntry {
  readonly until: number
  readonly reason: FailoverReason
  readonly detail: string
  readonly at: number
}

/**
 * 内存里的模型健康表（按 `provider/model` 记冷却）。
 *
 * 只放在内存：进程重启后重新试探是合理的（额度可能已经恢复），
 * 也不需要把"某个 key 挂了"这种瞬时状态写进磁盘。
 */
export class ModelHealth {
  private readonly dead = new Map<string, DeadEntry>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  private static key(candidate: ModelCandidate): string {
    return `${candidate.provider}/${candidate.model}`
  }

  mark_dead(candidate: ModelCandidate, reason: FailoverReason, detail: string, ms: number): DeadEntry {
    const entry: DeadEntry = { until: this.now() + ms, reason, detail: detail.slice(0, 200), at: this.now() }
    this.dead.set(ModelHealth.key(candidate), entry)
    return entry
  }

  mark_alive(candidate: ModelCandidate): void {
    this.dead.delete(ModelHealth.key(candidate))
  }

  is_dead(candidate: ModelCandidate): boolean {
    const entry = this.dead.get(ModelHealth.key(candidate))
    if (entry === undefined) return false
    if (entry.until <= this.now()) {
      this.dead.delete(ModelHealth.key(candidate))     // 冷却到期：自动恢复尝试
      return false
    }
    return true
  }

  /** 当前失活的模型（供控制台/诊断展示）。 */
  snapshot(): Array<ModelCandidate & DeadEntry> {
    const out: Array<ModelCandidate & DeadEntry> = []
    for (const [key, entry] of this.dead) {
      if (entry.until <= this.now()) continue
      const [provider, ...rest] = key.split('/')
      out.push({ provider: provider ?? '', model: rest.join('/'), ...entry })
    }
    return out
  }
}
