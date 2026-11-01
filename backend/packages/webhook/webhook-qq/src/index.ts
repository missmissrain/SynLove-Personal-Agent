/**
 * QQ 官方机器人通道（Cordis 函数式插件）——**与微信通道并存**，互不影响。
 *
 * 做什么：
 * - 用官方 WebSocket 网关收 `C2C_MESSAGE_CREATE`（单聊）/`GROUP_AT_MESSAGE_CREATE`（群 @）；
 * - 复用微信那边的 `HarnessSessionHost`（**不改微信包**）：`qq-<openid>` 一个会话，
 *   同一套 Agent / 工具 / 记忆 / 人格；
 * - 一轮结束后把回复**带回 QQ**：优先"被动回复"（带 msg_id，单聊 60 分钟内最多 4 次），
 *   失败自动退回"主动推送"（不受 5 分钟窗口限制，受频控）。
 *
 * 为什么不复用微信的协调器：那套围绕 iLink 的 delivery/outbox/lease 设计（含发送窗口停放），
 * QQ 是官方接口、窗口宽松，硬套反而要改微信代码。这里只借"会话宿主"，其余保持独立 ——
 * 这就是"最小修改"。
 *
 * @module dsh-webhook-qq
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessSessionHost, probe, get_shared_memory, register_timeline_tools, register_graph_tools } from '@deepseek-ai/dsh-webhook-weixin'
import { QqGateway } from './gateway.ts'
import { send_qq_media, send_qq_text, type QqSendTarget } from './send.ts'
import { QqTokenProvider } from './token.ts'
import { QqOutbox } from './QqOutbox.ts'
import { QqRemoteOutbox } from './QqRemoteOutbox.ts'
import { QqStateRemoteClient } from './QqStateRemoteClient.ts'
import { QqRemoteLease } from './QqRemoteLease.ts'
import { QqGatewayLease } from './QqGatewayLease.ts'

/**
 * 共享会话 id（微信和 QQ 单聊共用同一段上下文）。
 *
 * 开关：`DSH_SESSION_SHARED` 非空时启用；具体 id 由微信侧写进
 * `$DSH_HOME/shared-session.txt`（清空上下文时它会跟着代次变），
 * QQ 每次读文件，保证两边始终指向同一个会话。
 * **群聊不参与共享**（`qq-g-...`），否则群里陌生人会和主人混成一段对话。
 */
function shared_session_id(): string {
  if ((process.env.DSH_SESSION_SHARED ?? '').trim() === '') return ''
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  try {
    return readFileSync(join(home, 'shared-session.txt'), 'utf8').split('\n')[0]?.trim() ?? ''
  } catch {
    return 'main'
  }
}

/** Cordis function-plugin 名称。 */
export const name = 'webhook-qq'

/** 依赖的 Harness 原生服务（缺任一则插件不激活，而不是等第一条消息才炸）。 */
export const inject = ['agents', 'agentPresets', 'sessionPersistence']

/** 通道配置：AppID/AppSecret 由启动器从 config/secrets.json 注入环境变量。 */
export interface Config {
  /** 机器人 AppID（开放平台管理端） */
  app_id: string
  /** 机器人 AppSecret（机密，建议走环境变量） */
  client_secret: string
  /** Agent 工作目录 */
  workspace_path: string
  /** 模型 provider */
  provider: string
  /** 模型 id */
  model: string
  /** Agent 预设（挂哪些工具/人格） */
  agent_preset?: string
  /** 接口基址 */
  base_url?: string
  /** 订阅 intents 位图（默认 1<<25 群@+单聊） */
  intents?: number
}

/** Schemastery 配置定义。 */
export const Config: z<Config> = z.object({
  app_id: z.string().required(),
  client_secret: z.string().role('secret').required(),
  workspace_path: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  agent_preset: z.string(),
  base_url: z.string(),
  intents: z.number(),
})

/** 一条待回复：本轮累积的正文 + 触发它的消息 id 与目标。 */
interface PendingReply {
  text: string
  msgId?: string
  target: QqSendTarget
}

/** 注册 QQ 通道（生命周期跟随 Cordis effect）。 */
export function apply(ctx: Context, config: Config): void {
  if (!config.app_id.trim()) throw new Error('webhook-qq app_id must be non-empty')
  if (!config.client_secret.trim()) throw new Error('webhook-qq client_secret must be non-empty')
  probe('lifecycle', 'qq.plugin.apply', { app_id: config.app_id, preset: config.agent_preset ?? '', shared_env: process.env.DSH_SESSION_SHARED ?? '', shared_id: shared_session_id() })

  const host = new HarnessSessionHost(ctx, {
    ...config.agent_preset === undefined ? {} : { agent_preset: config.agent_preset },
    workspace_path: config.workspace_path,
    provider: config.provider,
    model: config.model,
  })
  host.assert_capabilities()

  const tokens = new QqTokenProvider({
    appId: config.app_id,
    clientSecret: config.client_secret,
    ...config.base_url === undefined ? {} : { baseUrl: config.base_url },
  })
  /** 每个会话本轮要发出去的内容。 */
  const pending = new Map<string, PendingReply>()
  /** 已经绑定过流监听的会话。 */
  const bound = new WeakSet<object>()
  let outbox: QqOutbox | QqRemoteOutbox | undefined
  /** 各会话最近一条消息 id（媒体被动回复要用）。 */
  const last_msg = new Map<string, string>()
  /** 已经装过记忆查询工具（timeline 系列 / relation_query）的 agent ctx。 */
  /** 助手回复的落档序号（按会话，保证 id 稳定不重）。 */
  const asst_seq = new Map<string, number>()

  /** 把一条 QQ 消息写进长期记忆时间线（写入由后台链路做，模型只有读工具）。 */
  const record_memory = async (session_id: string, role: 'user' | 'assistant', text: string, stable_id: string): Promise<void> => {
    const suite = get_shared_memory()
    if (suite === undefined) return
    try {
      await suite.timeline.append({
        id: stable_id,
        ts: Date.now(),
        role,
        text,
        session_id,
        user_id: session_id,
      })
    } catch (error) {
      probe('memory', 'qq.record_failed', { error: String(error) })
    }
  }

  /** 给当前 agent 装只读查询工具（timeline_days/search/read、relation_query）。 */
  const register_query_tools = (ctx: unknown): void => {
    const suite = get_shared_memory()
    if (suite === undefined) return
    register_timeline_tools(ctx as never, suite.timeline)
    register_graph_tools(ctx as never, suite.graph)
  }

  /** 一轮结束（或被取消）时把积累的正文发回 QQ。 */
  const flush = async (session_id: string): Promise<void> => {
    const item = pending.get(session_id)
    if (item === undefined || item.text.trim() === '') return
    const seq = (asst_seq.get(session_id) ?? 0) + 1
    asst_seq.set(session_id, seq)
    await record_memory(session_id, 'assistant', item.text.trim(), `qq-asst-${session_id}-${seq}`)
    {
      await get_outbox().enqueue_reply(item)
      pending.delete(session_id)
      await get_outbox().drain_queue()
    }
  }

  /** 首次见到某个 agent 时绑定流监听（每个 agent 只绑一次）。 */
  const bind_stream = (agent: { ctx: { on(name: string, listener: (payload: unknown) => void): unknown } }, session_id: string): void => {
    if (bound.has(agent)) return
    bound.add(agent)
    agent.ctx.on('agent/assistant-stream', (payload: unknown) => {
      if ((payload as { agent?: unknown }).agent !== undefined && (payload as { agent?: unknown }).agent !== agent) return
      const frame = (payload as { frame?: { type?: string; chunk?: { type?: string; text?: string } } }).frame
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
      const item = pending.get(session_id)
      if (item !== undefined) item.text += chunk.text
    })
    agent.ctx.on('agent/turn-stopping', (payload: unknown) => {
      if ((payload as { agent?: unknown }).agent !== undefined && (payload as { agent?: unknown }).agent !== agent) return
      void flush(session_id).catch(error => probe('outbound', 'qq.flush_failed', { error: String(error).slice(0, 160) }))
    })
  }

  /**
   * 取（或建）会话对应的 Agent。
   *
   * 为什么需要重试：上一轮结束后，**后台压缩**还在写同一个 session 文件，
   * 它会占着写句柄；这时新消息进来 `create/resume` 会抛
   * `SessionAlreadyOwnedError: already owned by an active write handle`。
   * 用户看到的就是"我这边刚才没处理成"。所以这里等一会儿再试（最多 45 秒），
   * 压缩一结束就能拿到 Agent，消息不会丢。
   */
  const wait_for_agent = async (session_id: SessionId): Promise<Agent> => {
    const deadline = Date.now() + 45_000
    let last_error: unknown
    while (Date.now() < deadline) {
      const live = host.get_agent(session_id)
      if (live !== undefined) return live
      try {
        return await host.create_agent(session_id)
      } catch (error) {
        last_error = error
        const message = String((error as Error)?.message ?? error)
        if (!/SessionAlreadyOwned|already owned|already exists|正在写入|busy/i.test(message)) throw error
        probe('inbound', 'qq.session_busy', { session_id: String(session_id), retry_ms: 2000 })
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    throw last_error ?? new Error('会话一直被占用，等不到写入句柄')
  }

  /** 处理一条入站消息：建/恢复会话 → 注入（运行中则插话）。 */
  const handle_event = async (kind: string, data: Record<string, unknown>): Promise<void> => {
    const author = (data.author ?? {}) as { user_openid?: string; id?: string; member_openid?: string }
    const openid = author.user_openid ?? author.member_openid ?? author.id
    const content = typeof data.content === 'string' ? data.content.trim() : ''
    const msg_id = typeof data.id === 'string' ? data.id : undefined
    const group = typeof data.group_openid === 'string' ? data.group_openid : undefined
    if (openid === undefined || content === '') return

    const shared = group === undefined ? shared_session_id() : ''
    const session_id = brandString<SessionId>(shared !== ''
      ? shared
      : `qq-${group === undefined ? openid : `g-${group}-${openid}`}`)
    const target: QqSendTarget = group === undefined ? { userOpenid: openid } : { groupOpenid: group }
    probe('inbound', 'qq.message', { kind, session_id: String(session_id), chars: content.length, group: group !== undefined })
    if (msg_id !== undefined) await record_memory(String(session_id), 'user', content, `qq-${msg_id}`)

    try {
      // 共享会话时微信那边可能已经建好同一个 Agent：先取，取不到再建（否则 create 会"已存在"冲突）。
      const agent = await wait_for_agent(session_id)
      register_query_tools((agent as unknown as { ctx: unknown }).ctx)
      // 微信/QQ 共用 Agent scope；每次入站更新当前通道，不能只按 QQ 的会话集合判重。
      const session_key = String(session_id)
      if (msg_id !== undefined) last_msg.set(session_key, msg_id)
      const media_tool = defineTool({
          name: 'send_file',
          description: '把本地图片/视频/语音/文档真正发到当前 QQ 聊天（不是只给路径）。用户说"发我""发过来""截图给我"时用它。',
          parameters: {
            path: { type: 'string', description: '本地文件绝对路径（20MB 以内）' },
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
            const result = await send_qq_media(tokens, target, file, last_msg.get(session_key), config.base_url)
            if (result.ok) return { ok: true, text: `已发送：${file}（${result.mode}）` }
            return { ok: false, text: `发送失败：${result.error ?? '未知错误'}` }
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
      bind_stream(agent as never, String(session_id))
      pending.set(String(session_id), {
        text: pending.get(String(session_id))?.text ?? '',
        ...msg_id === undefined ? {} : { msgId: msg_id },
        target,
      })
      const message = createUserMessage({
        content: [{ type: 'text', text: content }],
        source: { kind: 'plugin', plugin: 'webhook-qq', form: 'notice', summary: 'QQ 消息' },
      })
      if (agent.status === 'idle') agent.followup(message)
      else agent.steer(message)
    } catch (error) {
      probe('inbound', 'qq.handle_failed', { session_id: String(session_id), error: String(error).slice(0, 160) })
      console.error(`[webhook-qq] 处理消息失败：${String(error).slice(0, 200)}`)
      await send_qq_text(tokens, target, '我这边刚才没处理成，稍后再试一次好吗？', msg_id, config.base_url)
    }
  }

  /** 无参数；仅当前网关的实际发送链按需打开本地队列。 */
  const get_outbox = (): QqOutbox | QqRemoteOutbox => {
    if (outbox !== undefined) return outbox
    const send = async (row: { sent_parts: number[]; target: QqSendTarget; text: string; msgId?: string }, mark: (index: number) => void): Promise<Awaited<ReturnType<typeof send_qq_text>>> => {
      const progress = { sent_parts: row.sent_parts, on_sent: mark }
      const result = await send_qq_text(tokens, row.target, row.text, row.msgId, config.base_url, progress)
      if (!result.ok && result.mode === 'passive' && /HTTP 400|HTTP 403/.test(result.error ?? '')) {
        return send_qq_text(tokens, row.target, row.text, undefined, config.base_url, progress)
      }
      return result
    }
    const report = (state: Record<string, unknown>): void => probe('outbound', 'qq.send', state)
    if ((process.env.SYNLOVE_QQ_STATE_MODE ?? 'local').trim().toLowerCase() === 'remote') {
      outbox = new QqRemoteOutbox(new QqStateRemoteClient(), send, report)
    } else {
      outbox = new QqOutbox(
        process.env.DSH_QQ_OUTBOX ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'qq-outbox.json'),
        send,
        report,
      )
    }
    return outbox
  }

  const gateway = new QqGateway({
    token: () => tokens.get(),
    ...config.intents === undefined ? {} : { intents: config.intents },
    ...config.base_url === undefined ? {} : { baseUrl: config.base_url },
    on_event: (event) => { void handle_event(event.t, event.d) },
    on_health: state => probe('lifecycle', 'qq.health', { ...state, pid: process.pid }),
    log: (message) => { console.error(`[webhook-qq] ${message}`); probe('lifecycle', 'qq.gateway', { message: message.slice(0, 160) }) },
  })
  // 单实例锁：两个 harness 同时连同一个机器人会被平台互相踢（op=7 死循环）。
  const lock_path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'qq-gateway.pid')
  const remote_state = (process.env.SYNLOVE_QQ_STATE_MODE ?? 'local').trim().toLowerCase() === 'remote'
  const lock_held = (() => {
    try {
      const pid = Number(readFileSync(lock_path, 'utf8').trim())
      if (pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
    } catch {
      return false
    }
    return false
  })()
  // 生命周期挂在 Cordis effect 上：插件卸载时关掉网关，不留野连接。
  ctx.effect(async () => {
    if (!remote_state && lock_held) {
      console.error('[webhook-qq] 另一个实例已占用网关（qq-gateway.pid），本实例不连 QQ')
      probe('lifecycle', 'qq.gateway.skip_duplicate', { pid: process.pid })
      return () => {}
    }
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const remote_client = remote_state ? new QqStateRemoteClient() : undefined
    const lease = remote_client === undefined
      ? new QqGatewayLease(join(home, 'qq-gateway-lease.db'))
      : new QqRemoteLease(remote_client, config.app_id)
    if (!await lease.acquire_lease()) {
      await lease.release_lease()
      probe('lifecycle', 'qq.gateway.skip_duplicate', { pid: process.pid })
      return () => {}
    }
    let retry: ReturnType<typeof setInterval> | undefined
    try {
      if (!remote_state) writeFileSync(lock_path, String(process.pid), 'utf8')
      get_outbox()
      retry = setInterval(() => {
        void outbox?.drain_queue().catch(error => probe('outbound', 'qq.outbox_failed', { error: String(error).slice(0, 160) }))
      }, 5_000)
      void get_outbox().drain_queue().catch(error => probe('outbound', 'qq.outbox_failed', { error: String(error).slice(0, 160) }))
      gateway.start()
      probe('lifecycle', 'qq.gateway.start', {})
    } catch (error) {
      if (retry !== undefined) clearInterval(retry)
      outbox?.stop_queue()
      await lease.release_lease()
      try {
        if (!remote_state && readFileSync(lock_path, 'utf8').trim() === String(process.pid)) unlinkSync(lock_path)
      } catch { /* ignore */ }
      throw error
    }
    return async () => {
      gateway.stop()
      if (retry !== undefined) clearInterval(retry)
      outbox?.stop_queue()
      await lease.release_lease()
      try {
        if (!remote_state && readFileSync(lock_path, 'utf8').trim() === String(process.pid)) unlinkSync(lock_path)
      } catch { /* ignore */ }
      probe('lifecycle', 'qq.gateway.stop', {})
    }
  })
}
