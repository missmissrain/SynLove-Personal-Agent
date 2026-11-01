/**
 * 入站协调器：微信链路唯一的消息协调者。
 *
 * 重构设计文档 §3.2 / §6：负责幂等登记、路由、控制命令、投递顺序与恢复。
 * 它**不**维护模型执行状态（那是 Harness Agent inbox 的职责），**不**维护第二套队列，
 * **不**负责发送（那是 OutboundCoordinator）。
 *
 * 关键变化（对应诊断 1/2/4/5/6）：
 * - 全局单串行链 → 按 user_id 分片的 keyed scheduler（同用户保序，不同用户并发）；
 * - 控制命令也走同一个状态机并做 delivery 去重；
 * - 停止回执使用真实路由 SessionId，而不是 `weixin-${user_id}` 拼接；
 * - cursor 提交改为"批次内所有 delivery 达到终态"语义；
 * - 媒体下载与附件保存只阻塞该用户，不阻塞全局。
 * @module dsh-webhook-weixin/inbound-coordinator
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { probe, probe_timer } from '../diagnostics/probe.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WeixinAttachmentStore, WeixinSessionHost } from '../session/weixinSessionHost.ts'
import type { NormalizedMedia, NormalizedWeixinMessage } from '../message/messageNormalizer.ts'
import { INFLIGHT_TURN_PREFIX } from '../state/weixinStateStore.ts'
import type { TurnContextStore } from '../state/turnContextStore.ts'
import type { CodexCommand } from './codexBridge.ts'
import type { OpencodeCommand } from './opencodeBridge.ts'
import type { ControlCommand } from '../types/domain.ts'
import type { TimelineEntry } from '../memory/timelineTypes.ts'
import { is_cursor_committable } from '../types/domain.ts'

/**
 * 把规范化入站消息序列化成可持久化 JSON。
 *
 * 刻意**剥离二进制**（data/raw_data）：只保留文本与媒体下载引用（`media`），
 * 恢复时若需要原件再按引用重新下载（见 hydrate_message 注入）。
 */
function serialize_payload(message: NormalizedWeixinMessage): string {
  return JSON.stringify({
    delivery_id: message.delivery_id,
    user_id: message.user_id,
    ...message.context_token === undefined ? {} : { context_token: message.context_token },
    text: message.text,
    received_at: message.received_at,
    media: message.media.map(item => ({
      kind: item.kind,
      ...item.name === undefined ? {} : { name: item.name },
      ...item.mime_type === undefined ? {} : { mime_type: item.mime_type },
      ...item.source_text === undefined ? {} : { source_text: item.source_text },
      ...item.media === undefined ? {} : { media: item.media },
    })),
  })
}

/** 反序列化入站消息；结构不可信时返回 undefined（宁可判为无法恢复）。 */
function deserialize_payload(raw: string): NormalizedWeixinMessage | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<NormalizedWeixinMessage>
    if (typeof parsed.delivery_id !== 'string' || typeof parsed.user_id !== 'string') return undefined
    return {
      delivery_id: parsed.delivery_id,
      user_id: parsed.user_id,
      ...parsed.context_token === undefined ? {} : { context_token: parsed.context_token },
      text: typeof parsed.text === 'string' ? parsed.text : '',
      media: Array.isArray(parsed.media) ? parsed.media : [],
      received_at: typeof parsed.received_at === 'number' ? parsed.received_at : Date.now(),
    }
  } catch {
    return undefined
  }
}

/**
 * 把同一合并窗口里的若干条消息并成"一条"。
 *
 * 规则：文本按收到顺序用换行连起来；媒体依次拼接；**context_token 取最后一条**——
 * 回复窗口是"用户最近一次发言"开的，用最后那条的 token 才发得出去。
 */
export function merge_messages(messages: readonly NormalizedWeixinMessage[]): NormalizedWeixinMessage {
  const last = messages[messages.length - 1]!
  const first = messages[0]!
  const text = messages
    .map(item => item.text.trim())
    .filter(item => item !== '')
    .join('\n')
  const media = messages.flatMap(item => [...item.media])
  return {
    ...last,
    // 用第一条的 delivery_id 作代表（它是最早那条，日志里好追）
    delivery_id: first.delivery_id,
    text,
    media,
    received_at: last.received_at,
  }
}

/** 仅媒体、无文字时最多缓存多少条媒体。 */
const PENDING_MEDIA_LIMIT = 20

/**
 * 合并窗口（毫秒）：连续消息攒这么久再一次性交给模型。设 0 关闭合并（逐条立刻处理）。
 *
 * 取 6 秒是实测折中：打字停顿一般 1～3 秒，6 秒足够把"在吗 / 帮我看下 / 那个文件"
 * 收成一次提问，又不会让人觉得机器反应迟钝。
 */
const COALESCE_MS = Number(process.env.DSH_WEIXIN_COALESCE_MS ?? '6000')

/** 单条媒体下载/附件保存的超时（毫秒）。 */
const MEDIA_TIMEOUT_MS = Number(process.env.DSH_WEIXIN_MEDIA_TIMEOUT_MS ?? '120000')

/**
 * 单条 delivery 的最大处理尝试次数。
 * 超过就转 failed_terminal，让批次 cursor 能提交，避免"失败→重投→再失败"的热循环。
 */
const MAX_DELIVERY_ATTEMPTS = Number(process.env.DSH_WEIXIN_DELIVERY_MAX_ATTEMPTS ?? '3')

/**
 * 单个用户入站链的最大排队深度（背压阈值）。
 *
 * 超过就拒绝新消息并如实回执：没有上限时高频消息会无限占内存，
 * 而且排在后面的任务其实早就"过期"了，做出来也没意义。
 * 正常聊天远达不到这个数（一轮对话也就几条）。
 */
const MAX_SHARD_DEPTH = Number(process.env.DSH_WEIXIN_MAX_INBOUND_DEPTH ?? '30')

/** 取消当前任务时是否同时清理排队消息（设计文档 §4.2 默认语义：清理）。 */
const CANCEL_CLEARS_PENDING = true

/** 取消类指令。 */
const CANCEL_COMMANDS = new Set(['停止', '取消', '中断', '别做了', '停下', 'stop', 'cancel', 'abort', '中断任务', '停止任务'])

/** 保留队列的取消指令（显式语义，不是隐式行为）。 */
const CANCEL_KEEP_COMMANDS = new Set(['停止当前但保留队列', '取消当前但保留队列', 'stop-keep-queue'])

/** 插话指令前缀。 */
const STEER_PREFIXES = ['插话：', '插话:', '补充：', '补充:', '纠正：', '纠正:', 'steer:', 'steer：']

/** 状态查询指令。 */
const STATUS_COMMANDS = new Set(['状态', 'status'])

/** 解析控制命令；普通正文返回 undefined。 */
export function parse_control_command(text: string): ControlCommand | undefined {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  if (CANCEL_COMMANDS.has(lower)) return { kind: 'cancel_current', clear_pending: CANCEL_CLEARS_PENDING }
  if (CANCEL_KEEP_COMMANDS.has(lower)) return { kind: 'cancel_current', clear_pending: false }
  if (STATUS_COMMANDS.has(lower)) return { kind: 'status' }
  for (const prefix of STEER_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      const rest = trimmed.slice(prefix.length).trim()
      if (rest.length > 0) return { kind: 'steer_current', text: rest }
    }
  }
  return undefined
}

/** 出站入队回调（由 OutboundCoordinator 注入，避免反向依赖）。 */
export type EnqueueOutbound = (input: {
  session_id: string
  user_id: string
  kind: 'control_ack' | 'error' | 'progress'
  text: string
  context_token?: string
  turn?: number
}) => void

/** 构造参数。 */
export interface InboundCoordinatorOptions {
  /**
   * 本地 store 与远程 state client 在迁移期共存；具体调用必须 await 可能的 Promise。
   * 连接器完成整域切换后再收紧为显式端口接口。
   */
  readonly store: any
  /**
   * 轮次上下文存储；旧版测试和仅验证入站恢复的调用方可以省略。
   * 真实连接器仍会注入正式实例，省略时协调器不执行依赖它的附加操作。
   */
  readonly turn_context?: TurnContextStore
  readonly host: WeixinSessionHost
  readonly attachments?: WeixinAttachmentStore
  readonly enqueue_outbound: EnqueueOutbound
  /** Agent 就绪回调（用于绑定 assistant-stream 监听）。 */
  readonly on_agent_ready?: (agent: Agent) => void
  /** Agent 创建/恢复后回调，用于建立 turn 级上下文监听。 */
  readonly on_agent_bound?: (agent: Agent) => void
  /** 通道侧媒体发送能力（微信目前只支持图片）；不提供则 send_file 工具不注册 */
  readonly send_media?: (user_id: string, path: string, context_token?: string) => Promise<void>
  /**
   * 用户要求停止时的**外部任务中断**回调（可选）。
   *
   * 由连接器实现：杀掉 opencode/codex 正在跑的 `run` 进程，并停掉桥里的任务。
   * 返回实际杀掉的进程数——回执文案据此如实描述，不许无核实地说"已停止"。
   */
  readonly on_cancel?: (user_id: string) => Promise<{ killed: number, pids: readonly number[] }>

  /**
   * 用户取消后**必须**做的收尾（停心跳、清"进行中"标记、清聚合器）。
   *
   * 为什么不能只靠 `agent/turn-stopping`：实测 `agent.cancel()` 走 abort 路径时那个事件不会来，
   * 结果是心跳每 5 分钟继续发「还在处理中」、`inflight_turn` 标记也留着
   * （下次启动会把**已经取消的任务**当"被打断"重跑一遍）。
   */
  readonly on_turn_cancelled?: (session_id: string) => void

  /**
   * 每条真实用户消息（已定好会话）回调一次。
   *
   * 用途：模型故障转移时要"把用户刚才那条重做一遍"，所以连接器需要记住最后一条消息文本。
   * 只放在内存里、且只保留最近一条——不是聊天记录存储（那件事归时间线）。
   */
  readonly on_user_message?: (session_id: string, user_id: string, text: string) => void
  /**
   * Codex 远程桥（可选）。给了就会把 `/codex ...` 消息交给它，
   * 实现"微信遥控 Codex + Codex 输出主动推回微信"。
   */
  readonly codex_bridge?: {
    parse(text: string): CodexCommand | undefined
    handle(user_id: string, session_id: string, command: CodexCommand, context_token?: string): Promise<void>
  }
  /** opencode 远程桥（可选）：`/opencode ...` 走它，输出主动推微信。 */
  readonly opencode_bridge?: {
    parse(text: string): OpencodeCommand | undefined
    handle(user_id: string, session_id: string, command: OpencodeCommand, context_token?: string): Promise<void>
  }
  /**
   * 媒体补全（可选）：下载图片/文件/语音的字节并填入消息。
   *
   * 不给就退化成"只有 `[微信媒体 image]` 占位文字"，用户发的图/文件不会被真正保存。
   * 下载失败由实现内部降级为说明文字，不能因此让整条消息失败。
   */
  readonly hydrate_message?: (message: NormalizedWeixinMessage) => Promise<NormalizedWeixinMessage>
  /**
   * 把"用户上行"记进长期记忆（时间线）。
   *
   * 在 delivery **首次登记**时调用（不是注入成功后）：用户确实说了这句话，
   * 而且 delivery_id 天然稳定，重放/恢复不会记重复。
   */
  readonly record_entry?: (entry: TimelineEntry) => void | Promise<void>
}

/** 每个用户的分片状态：一条串行链 + 队列深度，互不阻塞。 */
interface UserShard {
  chain: Promise<void>
  depth: number
}

/** 微信入站协调器。 */
export class InboundCoordinator {
  private disposed = false
  private readonly shards = new Map<string, UserShard>()
  private readonly pending_media = new Map<string, NormalizedMedia[]>()
  /** 各用户最近一次 context_token（媒体被动回复要用） */
  private readonly latest_token = new Map<string, string>()
  /**
   * 同一个人连续发的消息先攒着，静默 COALESCE_MS 之后**合并成一条**喂给模型。
   *
   * 为什么要攒：人是断续打的（"在吗" → "帮我看看" → "那个文件"），逐条喂会得到三次回答，
   * 又慢又吵；合并成一次提问，模型也更容易答到点上。控制命令（`/codex`、`/opencode`）
   * 与纯媒体消息**不缓冲**，立刻处理。
   */
  private readonly coalesced = new Map<string, {
    messages: NormalizedWeixinMessage[]
    timer: ReturnType<typeof setTimeout>
    first_at: number
  }>()
  /** 合并窗口内最近一次收到消息的时间（用于日志里的"等了多久"）。 */
  private readonly coalesced_last_at = new Map<string, number>()
  /** delivery 成功注入后记录的 `delivery_id → session_id`，供 outbox 绑定使用。 */
  private readonly delivery_sessions = new Map<string, string>()

  /** 绑定状态库与宿主。 */
  constructor(private readonly options: InboundCoordinatorOptions) {}

  /** 暴露 delivery → session 映射（outbox 需要）。 */
  session_for_delivery(delivery_id: string): string | undefined {
    return this.delivery_sessions.get(delivery_id)
  }

  /**
   * 处理一个批次：逐条登记 + 分片投递，最后按"全部达到终态"决定是否提交 cursor。
   *
   * @param messages - 本批消息
   * @param cursor - 平台游标
   * @param options.hold - true 时**只登记不投递**（压缩上下文期间用）：
   *   delivery 停在 `received` 且 payload 已落库，压缩结束后由 `recover_unfinished()` 重投。
   *   此时故意不返回可提交，让游标保持未提交、消息不会丢。
   * @returns 是否允许提交该批次 cursor。
   */
  async handle_batch(
    messages: readonly NormalizedWeixinMessage[],
    cursor: string | undefined = undefined,
    options?: { hold?: boolean },
  ): Promise<boolean> {
    const done = probe_timer('inbound', 'batch.start', {
      count: messages.length, has_cursor: cursor !== undefined, hold: options?.hold === true,
    })
    const tasks: Array<Promise<void>> = []
    for (const message of messages) {
      // 幂等登记在**任何异步分片之前**同步完成，避免同批次重复投递。
      const put_result = this.options.store.put_delivery_if_absent({
        delivery_id: message.delivery_id,
        user_id: message.user_id,
        received_at: message.received_at,
        // 回复必须用本条消息的 context_token，所以从入站就把它持久化下来。
        ...message.context_token === undefined ? {} : { context_token: message.context_token },
        // 落一份可恢复的入站事实：崩溃后据此重新注入，而不是假定"已喂给模型"。
        payload_json: serialize_payload(message),
      })
      const first = put_result instanceof Promise ? await put_result : put_result
      if (!first) {
        probe('inbound', 'batch.skip_duplicate', { delivery_id: message.delivery_id })
        // 上次异步合并失败的消息仍由当前用户分片重试，不再永久跳过。
        const duplicate = this.options.store.get_delivery(message.delivery_id)
        const duplicate_record = duplicate instanceof Promise ? await duplicate : duplicate
        if (duplicate_record?.status === 'failed_retryable') {
          tasks.push(this.enqueue_for_user(message))
        }
        continue
      }
      // 长期记忆：记下用户这句话（幂等由 delivery_id 保证）。
      const route_result = this.options.store.get_session_id(message.user_id)
      const route = route_result instanceof Promise ? await route_result : route_result
      const recorded = this.options.record_entry?.({
        id: message.delivery_id,
        ts: message.received_at,
        role: 'user',
        text: message.text,
        user_id: message.user_id,
        ...route === undefined
          ? {}
          : { session_id: route as string },
      })
      // 本地存储是同步追加，不额外让出批处理循环；远程端口返回 Promise 时才等待提交。
      if (recorded !== undefined) await recorded
      // 压缩上下文期间：只入库、不进会话。压缩结束后恢复流程会把它们重投。
      if (options?.hold === true) {
        probe('inbound', 'batch.held', { delivery_id: message.delivery_id, user_id: message.user_id })
        continue
      }
      tasks.push(this.enqueue_for_user(message))
    }

    // 等待所有分片任务"落库为终态或明确失败"，而不是等模型跑完。
    const settled = await Promise.allSettled(tasks)
    const rejected = settled.filter(item => item.status === 'rejected').length
    if (rejected > 0) probe('inbound', 'batch.task_rejected', { rejected })

    const ids = messages.map(message => message.delivery_id)
    const committable = await this.options.store.batch_committable(ids)
    done({ committable, rejected })
    return committable
  }

  /** 把一条消息排进其所属用户的分片链；同用户严格保序，不同用户并发。 */
  private async enqueue_for_user(message: NormalizedWeixinMessage, run?: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const previous = this.shards.get(message.user_id) ?? { chain: Promise.resolve(), depth: 0 }

    // **背压**：同一个人堆积太多就不收了。
    // 没有上限的话，高频消息会无限占用内存（审计指出：无深度/字节/超时/拒绝策略）。
    // 处理方式：明确拒绝并**如实回执**，而不是让它排在后面变成僵尸任务。
    if (previous.depth >= MAX_SHARD_DEPTH) {
      probe('inbound', 'shard.overflow', {
        user_id: message.user_id, depth: previous.depth, limit: MAX_SHARD_DEPTH,
      })
      const updated = this.options.store.update_delivery(message.delivery_id, 'failed_terminal', {
        last_error: `入站队列过深（${previous.depth} ≥ ${MAX_SHARD_DEPTH}），已丢弃`,
        increment_attempt: true,
      })
      if (updated instanceof Promise) await updated
      const route = this.options.store.get_session_id(message.user_id)
      if (route instanceof Promise) {
        const session_id = (await route) ?? `weixin-${message.user_id}`
        this.options.enqueue_outbound({
          session_id,
          user_id: message.user_id,
          kind: 'error',
          text: `消息一下有点多啦，这条我先放一放（队列已满 ${MAX_SHARD_DEPTH} 条）😅 稍后再发一次好吗？`,
        })
        return
      }
      this.options.enqueue_outbound({
        session_id: route instanceof Promise
          ? `weixin-${message.user_id}`
          : route ?? `weixin-${message.user_id}`,
        user_id: message.user_id,
        kind: 'error',
        text: `消息一下有点多啦，这条我先放一放（队列已满 ${MAX_SHARD_DEPTH} 条）😅 稍后再发一次好吗？`,
      })
      return
    }

    const shard: UserShard = { chain: previous.chain, depth: previous.depth + 1 }
    this.shards.set(message.user_id, shard)
    probe('inbound', 'shard.enqueue', { user_id: message.user_id, depth: shard.depth })

    const task = shard.chain.then(async () => {
      await (run === undefined ? this.process_message(message) : run())
    })
    // 链本身吞错（一条失败不能毒化该用户后续消息），但返回值让批次能感知失败。
    shard.chain = task.catch(error => {
      probe('inbound', 'shard.task_failed', {
        user_id: message.user_id, delivery_id: message.delivery_id, error: String(error),
      })
    }).finally(() => {
      const current = this.shards.get(message.user_id)
      if (current !== undefined) {
        // 保持 depth 计数用于诊断；归零后清理。
        current.depth = Math.max(0, current.depth - 1)
        if (current.depth === 0) this.shards.delete(message.user_id)
      }
    })
    return task
  }

  /** 处理单条消息：Codex 指令 / 控制命令 / 普通消息。 */
  private async process_message(message: NormalizedWeixinMessage): Promise<void> {
    // 先补全媒体：图片/文件/语音必须真的下载下来，否则模型只看到占位文字。
    // 补全失败不影响流程（内部已降级为说明文字），但记录探针便于排查。
    if (this.options.hydrate_message !== undefined && message.media.length > 0) {
      try {
        message = await this.options.hydrate_message(message)
      } catch (error) {
        probe('inbound', 'media.hydrate_failed', {
          delivery_id: message.delivery_id, error: String(error),
        })
      }
    }
    const control = parse_control_command(message.text)
    try {
      // `/opencode ...` 直接遥控本机 opencode（输出主动推送）。
      const oc_command = this.options.opencode_bridge?.parse(message.text)
      if (oc_command !== undefined && this.options.opencode_bridge !== undefined) {
        const session_id = (await this.options.store.get_session_id(message.user_id)) ?? `weixin-${message.user_id}`
        await this.options.store.update_delivery(message.delivery_id, 'control_applied', { injected_at: Date.now() })
        probe('inbound', 'opencode.command', { delivery_id: message.delivery_id, action: oc_command.action })
        await this.options.opencode_bridge.handle(
          message.user_id, session_id, oc_command, message.context_token,
        )
        return
      }
      // `/codex ...` 直接遥控本机 Codex，不经过大模型（用户明确要求的能力）。
      const codex_command = this.options.codex_bridge?.parse(message.text)
      if (codex_command !== undefined && this.options.codex_bridge !== undefined) {
        const session_id = (await this.options.store.get_session_id(message.user_id)) ?? `weixin-${message.user_id}`
        await this.options.store.update_delivery(message.delivery_id, 'control_applied', { injected_at: Date.now() })
        probe('inbound', 'codex.command', { delivery_id: message.delivery_id, action: codex_command.action })
        await this.options.codex_bridge.handle(
          message.user_id, session_id, codex_command,
          message.context_token,
        )
        return
      }
      if (control !== undefined) {
        await this.apply_control(message, control)
        return
      }
      await this.coalesce_message(message)
    } catch (error) {
      await this.handle_message_failure(message, error)
    }
  }

  /** message 为原始投递，error 为处理异常；统一计次、记录原错并在达到上限时发送失败回执。 */
  private async handle_message_failure(message: NormalizedWeixinMessage, error: unknown): Promise<void> {
      if (this.disposed) return
      const current = await this.options.store.get_delivery(message.delivery_id)
      if (current !== undefined && is_cursor_committable(current.status)) return
      const detail = error instanceof Error ? error.message : String(error)
      const attempt = ((await this.options.store.get_delivery(message.delivery_id))?.attempt ?? 0) + 1
      // 重试上限：超过就转终态。否则「注入失败 → 游标不提交 → 服务端重投 → 又失败」
      // 会变成热循环（实测一次 preset 挂载失败就打出上千条重复事件）。
      if (attempt >= MAX_DELIVERY_ATTEMPTS) {
        await this.options.store.update_delivery(message.delivery_id, 'failed_terminal', {
        last_error: detail, increment_attempt: true,
      })
        probe('inbound', 'message.failed_terminal', {
          delivery_id: message.delivery_id, attempt, error: detail,
        })
        // 明确告知用户这条没处理成功，而不是让它静默消失。
        this.options.enqueue_outbound({
          session_id: (await this.options.store.get_session_id(message.user_id)) ?? `weixin-${message.user_id}`,
          user_id: message.user_id,
          kind: 'error',
          text: '（这条消息处理失败了，我已经记录下来；请稍后再发一次或告诉我换种说法）',
          ...message.context_token === undefined ? {} : { context_token: message.context_token },
        })
        return
      }
      await this.options.store.update_delivery(message.delivery_id, 'failed_retryable', {
        last_error: detail, increment_attempt: true,
      })
      probe('inbound', 'message.failed', { delivery_id: message.delivery_id, attempt, error: detail })
  }

  /** 应用控制命令（幂等：delivery 已登记过就不会重复执行）。 */
  private async apply_control(message: NormalizedWeixinMessage, control: ControlCommand): Promise<void> {
    const done = probe_timer('inbound', 'control.apply', {
      delivery_id: message.delivery_id, user_id: message.user_id, command: control.kind,
    })
    const session_id = await this.options.store.get_session_id(message.user_id)
    if (session_id === undefined) {
      // 没有路由就没有可控制的 Agent：明确告知，而不是当普通正文丢给模型。
      await this.options.store.update_delivery(message.delivery_id, 'control_applied')
      this.options.enqueue_outbound({
        session_id: `weixin-unrouted:${message.user_id}`,
        user_id: message.user_id,
        kind: 'control_ack',
        text: '（当前没有正在进行的任务）',
        ...message.context_token === undefined ? {} : { context_token: message.context_token },
      })
      done({ outcome: 'no_route' })
      return
    }
    const agent = this.options.host.get_agent(brandString<SessionId>(session_id))
    if (agent === undefined) {
      await this.options.store.update_delivery(message.delivery_id, 'control_applied')
      this.options.enqueue_outbound({
        session_id,
        user_id: message.user_id,
        kind: 'control_ack',
        text: control.kind === 'status' ? '（当前空闲，没有正在进行的任务）' : '（当前没有正在进行的任务）',
        ...message.context_token === undefined ? {} : { context_token: message.context_token },
      })
      done({ outcome: 'no_agent' })
      return
    }

    if (control.kind === 'cancel_current') {
      if (agent.status === 'idle') {
        this.options.enqueue_outbound({
          session_id, user_id: message.user_id, kind: 'control_ack',
          text: '（当前没有正在进行的任务）',
          ...message.context_token === undefined ? {} : { context_token: message.context_token },
        })
      } else {
        // clear_pending 语义显式化：默认清理尚未开始的旧排队消息，避免停止后旧任务又自动执行。
        agent.cancel({ kind: 'user' }, { keepInbox: !control.clear_pending })
        // 用户主动取消 = 这一轮**不该**被"重启补跑"救回来。
        // 否则下次启动会把它当成"被打断的轮次"重新跑一遍（实测：取消掉的音量任务被重启复活）。
        await this.options.store.delete_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`)
        // abort 路径不会触发 `agent/turn-stopping`，所以这里手动收尾：停心跳 + 清轮次状态。
        this.options.on_turn_cancelled?.(session_id)
        // **同时中断外部 agent 的在跑进程**（opencode/codex）。
        // 只 cancel 模型那一轮是不够的：模型可能正卡在 `opencode run` 的工具调用上，
        // 那个子进程不会因为我们取消 turn 而退出（实测跑了 22 分钟，那一轮永远收不了尾）。
        const stopped = await this.options.on_cancel?.(message.user_id)
        const external = stopped === undefined || stopped.killed === 0
          ? ''
          : `，并中断了 ${stopped.killed} 个外部任务`
        // 文案必须**如实**：能确认的只有"这一轮已取消 + 外部进程已杀"，
        // 不能像以前那样直接断言"已停止"（人格里明确禁止装作已停止）。
        this.options.enqueue_outbound({
          session_id, user_id: message.user_id, kind: 'control_ack',
          text: `（已取消当前这一轮${external}${control.clear_pending ? '，排队消息已清空' : '，排队消息保留'}）`,
          ...message.context_token === undefined ? {} : { context_token: message.context_token },
        })
      }
    } else if (control.kind === 'steer_current') {
      if (agent.status === 'idle') {
        this.options.enqueue_outbound({
          session_id, user_id: message.user_id, kind: 'control_ack',
          text: '（没有正在进行的任务，插话未生效；请直接发消息）',
          ...message.context_token === undefined ? {} : { context_token: message.context_token },
        })
      } else {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: control.text }],
          source: { kind: 'plugin', plugin: 'dsh-webhook-weixin', form: 'notice', summary: '微信插话' },
        }))
        this.options.enqueue_outbound({
          session_id, user_id: message.user_id, kind: 'control_ack',
          text: '（已把你的补充插进当前任务）',
          ...message.context_token === undefined ? {} : { context_token: message.context_token },
        })
      }
    } else {
      // status：只读，不触发模型 turn。
      this.options.enqueue_outbound({
        session_id, user_id: message.user_id, kind: 'control_ack',
        text: `（状态：Agent ${agent.status}）`,
        ...message.context_token === undefined ? {} : { context_token: message.context_token },
      })
    }

    await this.options.store.update_delivery(message.delivery_id, 'control_applied', {
      session_id, injected_at: Date.now(),
    })
    done({ outcome: 'applied', agent_status: agent.status })
  }

  /**
   * 普通消息入口：先攒进合并窗口，静默一段时间后一次性注入。
   *
   * 不缓冲的情况：
   * - 关闭了合并（COALESCE_MS = 0）；
   * - 只有媒体没有文字 —— 那种要等用户补文字，交给 `inject_message` 自己的媒体缓存逻辑。
   */
  private async coalesce_message(message: NormalizedWeixinMessage): Promise<void> {
    const text = message.text.trim()
    if (COALESCE_MS <= 0 || (text === '' && message.media.length > 0)) {
      await this.inject_message(message)
      return
    }
    this.begin_routing(message.delivery_id)

    const existing = this.coalesced.get(message.user_id)
    if (existing !== undefined) clearTimeout(existing.timer)
    const messages = [...existing?.messages ?? [], message]
    const first_at = existing?.first_at ?? Date.now()
    const timer = setTimeout(() => {
      // 合并窗口到期后仍回到同用户串行链，避免与下一批入站并发修改同一 Agent。
      const task = this.enqueue_for_user(message, () => this.flush_coalesced(message.user_id))
      void task.catch(error => probe('inbound', 'coalesce.scheduler_failed', { error: String(error) }))
    }, COALESCE_MS)
    this.coalesced.set(message.user_id, { messages, timer, first_at })
    this.coalesced_last_at.set(message.user_id, Date.now())
    probe('inbound', 'coalesce.buffered', {
      user_id: message.user_id, pending: messages.length, window_ms: COALESCE_MS,
    })
  }

  /** 合并窗口到期：把攒下的消息并成一条注入（游标要等这条注入完才提交）。 */
  private async flush_coalesced(user_id: string): Promise<void> {
    const bucket = this.coalesced.get(user_id)
    if (bucket === undefined) return
    this.coalesced.delete(user_id)
    const waited = Date.now() - (this.coalesced_last_at.get(user_id) ?? Date.now())
    this.coalesced_last_at.delete(user_id)

    const merged = merge_messages(bucket.messages)
    // 除第一条之外的 delivery 也要标成 injected，否则它们的批次游标永远提交不了
    // （服务端会反复重投同一批消息）。
    const extras = bucket.messages.slice(1).map(item => item.delivery_id)
    probe('inbound', 'coalesce.flushed', {
      user_id, messages: bucket.messages.length, chars: merged.text.length,
      waited_ms: Date.now() - bucket.first_at, idle_ms: waited,
    })
    try {
      await this.inject_message(merged, extras)
    } catch (error) {
      probe('inbound', 'coalesce.inject_failed', { user_id, error: String(error) })
      for (const message of bucket.messages) await this.handle_message_failure(message, error)
    }
  }

  /** delivery_id 为已登记投递；复用既有 routing，只从明确可处理状态进入路由。 */
  private async begin_routing(delivery_id: string): Promise<void> {
    const row = await this.options.store.get_delivery(delivery_id)
    if (row?.status === 'routing') return
    const status = row?.status ?? 'received'
    if (status !== 'received' && status !== 'failed_retryable') throw new Error(`delivery 不可路由：${status}`)
    const claimed = await this.options.store.update_delivery(delivery_id, 'routing', { expect: status })
    if (claimed === false) {
      throw new Error('delivery 状态已变更，路由未获得所有权')
    }
  }

  /** 无参数；取消尚未到期的合并计时器，保留数据库载荷供下次恢复。 */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const bucket of this.coalesced.values()) clearTimeout(bucket.timer)
    this.coalesced.clear()
    this.coalesced_last_at.clear()
    await Promise.allSettled([...this.shards.values()].map(shard => shard.chain))
  }

  /** 普通消息：媒体 → Agent → followup → 标记 injected。 */
  private async inject_message(message: NormalizedWeixinMessage, also_mark: readonly string[] = []): Promise<void> {
    if (this.disposed) return
    const done = probe_timer('inbound', 'message.inject', {
      delivery_id: message.delivery_id, user_id: message.user_id,
    })
    await this.begin_routing(message.delivery_id)

    const text = message.text.trim()
    // 仅媒体、无文字：缓存等用户补文字，缓存成功即算 control_applied（该 delivery 已处理完）。
    if (!text && message.media.length > 0) {
      const pending = this.pending_media.get(message.user_id) ?? []
      pending.push(...message.media)
      while (pending.length > PENDING_MEDIA_LIMIT) pending.shift()
      this.pending_media.set(message.user_id, pending)
      await this.options.store.update_delivery(message.delivery_id, 'control_applied', { injected_at: Date.now() })
      done({ outcome: 'media_buffered', buffered: pending.length })
      return
    }

    const buffered = this.pending_media.get(message.user_id)
    if (buffered !== undefined && buffered.length > 0) this.pending_media.delete(message.user_id)
    const media = buffered === undefined || buffered.length === 0 ? message.media : [...buffered, ...message.media]

    // 路由 / 创建恢复 Agent（只用 Harness 原生能力）。
    let session_id = await this.options.store.get_session_id(message.user_id)
    let agent: Agent
    if (session_id !== undefined) {
      const branded = brandString<SessionId>(session_id)
      agent = this.options.host.get_agent(branded) ?? await this.options.host.resume_agent(branded)
    } else {
      // 会话 id 由 store 统一生成：它会带上"上下文代次"，所以清空过上下文之后
      // 这里拿到的一定是**新名字**（不会又恢复回旧会话）。
      session_id = await this.options.store.session_id_for(message.user_id)
      agent = await this.options.host.create_agent(brandString<SessionId>(session_id))
      await this.options.store.set_session_id(message.user_id, session_id)
    }
    const session_key = String(agent.id)
    if (this.disposed) return
    this.options.on_agent_ready?.(agent)
    this.options.on_agent_bound?.(agent)
    // 微信/QQ 共用 Agent scope；每次入站恢复当前通道的发送能力。
    if (message.context_token !== undefined) this.latest_token.set(message.user_id, message.context_token)
    if (this.options.send_media !== undefined) {
      const send_media = this.options.send_media
      const latest_token = this.latest_token
      const user_id = message.user_id
      const media_tool = defineTool({
        name: 'send_file',
        description: '把本地图片发到当前微信聊天（只支持 jpg/png/gif/webp 等图片；文件暂不支持）。用户说"发我""发过来""截图给我"时用它。',
        parameters: {
          path: { type: 'string', description: '本地图片绝对路径' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              text: { type: 'string', required: true },
            },
          },
          render: (_args: unknown, value: { ok: boolean, text: string }) => [{ type: 'text', text: value.text }],
        },
        async execute(args: { path?: string }) {
          const file = String(args.path ?? '').trim()
          if (file === '') return { ok: false, text: 'path 不能为空' }
          try {
            await send_media(user_id, file, latest_token.get(user_id))
            return { ok: true, text: `已发送：${file}` }
          } catch (error) {
            return { ok: false, text: `发送失败：${String(error).slice(0, 160)}` }
          }
        },
      })
      const current = agent.ctx.tools.get('send_file', agent)
      if (current === undefined) {
        agent.ctx.tools.register(media_tool)
      } else {
        // 注册表保留原定义对象；复用其 effect，仅刷新发送目标与模型可见说明。
        current.description = media_tool.description
        current.parameters = media_tool.parameters
        current.execute = media_tool.execute
      }
    }
    // 记住这条消息（换模型后要重做它）；只记文本，不落盘
    this.options.on_user_message?.(session_key, message.user_id, text)

    const content = await this.build_content(text, media)
    if (content.length === 0) content.push({ type: 'text', text: '[微信空消息]' })

    // **运行中插话就直接插进当前这轮**（steering），不要排到下一轮。
    //
    // 为什么：`followup()` 会把消息留到本轮结束才处理 —— 用户想说"停一下 / 改成那样"，
    // 却要等一整轮跑完才生效，体验很差。`steer()` 把消息追加到当前对话，
    // 模型在**下一个 step** 就能看到，可以立刻改动作或收手。
    // 空闲时仍然用 followup（正常开新一轮）。
    const incoming = createUserMessage({
      content,
      source: { kind: 'plugin', plugin: 'dsh-webhook-weixin', form: 'notice', summary: '微信消息' },
    })
    if (this.disposed) return
    const steering = agent.status !== 'idle'
    if (steering) {
      agent.steer(incoming)
      probe('inbound', 'message.steer', { delivery_id: message.delivery_id, session_id: session_key })
    } else {
      agent.followup(incoming)
    }
    // 记录 delivery → session，供 outbox 与 turn context 使用。
    this.delivery_sessions.set(message.delivery_id, session_key)
    await this.options.store.update_delivery(message.delivery_id, 'injected', {
      session_id: session_key, injected_at: Date.now(),
    })
    // 合并窗口里被并进来的其它消息：同一轮回答覆盖了它们，一起标成已注入，
    // 否则那些 delivery 停在 routing，批次游标提交不了（服务端会反复重投）。
    for (const delivery_id of also_mark) {
      this.delivery_sessions.set(delivery_id, session_key)
      await this.options.store.update_delivery(delivery_id, 'injected', {
        session_id: session_key, injected_at: Date.now(),
      })
    }
    done({ outcome: 'injected', session_id: session_key, blocks: content.length, merged: also_mark.length })
  }

  /** 构造消息内容块；媒体下载失败降级为说明文本，不影响文字投递。 */
  private async build_content(text: string, media: readonly NormalizedMedia[]): Promise<ContentBlock[]> {
    const content: ContentBlock[] = []
    if (text) content.push({ type: 'text', text })
    for (const item of media) {
      try {
        if (item.data && item.kind === 'image' && this.options.attachments) {
          const media_type = item.mime_type === 'image/png' || item.mime_type === 'image/webp' || item.mime_type === 'image/gif'
            ? item.mime_type
            : 'image/jpeg'
          const attachment = await with_timeout(
            this.options.attachments.saveImage({ data: item.data, mediaType: media_type, ...item.name === undefined ? {} : { name: item.name } }),
            MEDIA_TIMEOUT_MS,
            'saveImage',
          )
          content.push({ type: 'image', attachment })
        } else if (item.data && item.kind === 'file' && this.options.attachments?.saveFile) {
          const attachment = await with_timeout(
            this.options.attachments.saveFile({ data: item.data, ...item.name === undefined ? {} : { name: item.name } }),
            MEDIA_TIMEOUT_MS,
            'saveFile',
          )
          content.push({ type: 'file', attachment })
        } else {
          const note = `[微信媒体 ${item.kind}${item.source_text ? `:${item.source_text}` : ''}]`
          content.push({ type: 'text', text: note })
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        probe('inbound', 'media.failed', { kind: item.kind, error: detail })
        content.push({ type: 'text', text: `[微信媒体 ${item.kind} 处理失败：${detail}]` })
      }
    }
    return content
  }

  /**
   * 恢复未完成的 delivery（设计文档 §5.2 的恢复协议）。
   *
   * 关键：**不能因为 delivery 已有 session_id 就把它标成 injected**。那样会掩盖这个窗口：
   * `delivery 已登记 → session_id 已写入 → agent.followup() 尚未执行 → 进程崩溃`。
   * 有 `payload_json` 的必须重新走一遍完整注入，成功才由 process_message 写 injected；
   * 失败则保持 failed_retryable，交给现有重试机制——绝不"假成功"地丢消息。
   */
  async recover_unfinished(): Promise<{ recovered: number; needs_reinject: number }> {
    const unfinished = await this.options.store.list_unfinished_deliveries()
    let needs_reinject = 0
    let reinjected = 0
    for (const record of unfinished) {
      if (record.payload_json !== undefined) {
        const message = deserialize_payload(record.payload_json)
        if (message !== undefined) {
          needs_reinject += 1
          probe('inbound', 'recover.reinject', {
            delivery_id: record.delivery_id, user_id: record.user_id, from_status: record.status,
          })
          // process_message 内部自会落状态（injected / failed_*），此处不再代写。
          await this.enqueue_for_user(message)
          reinjected += 1
          continue
        }
      }
      // 缺少原始载荷时不能以“有会话”冒充注入成功；保留明确的失败事实。
      needs_reinject += 1
      await this.options.store.update_delivery(record.delivery_id, 'failed_terminal', {
        last_error: '无法恢复：入站载荷缺失，未重新执行',
      })
    }
    probe('inbound', 'recover.done', { unfinished: unfinished.length, needs_reinject, reinjected })
    return { recovered: unfinished.length, needs_reinject }
  }

  /** 该 delivery 是否可提交 cursor。 */
  is_committable(delivery_id: string): boolean {
    const record = this.options.store.get_delivery(delivery_id)
    return record !== undefined && is_cursor_committable(record.status)
  }

  /** 异步查询 delivery 是否可提交，供远程状态端口使用。 */
  async is_committable_async(delivery_id: string): Promise<boolean> {
    const record = await this.options.store.get_delivery(delivery_id)
    return record !== undefined && is_cursor_committable(record.status)
  }
}

/** 给 promise 加超时，避免单个媒体处理拖住整个用户分片。 */
async function with_timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
