/** 微信 iLink Cordis 插件：校验配置并把连接器生命周期交给 effect。 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { probe } from './diagnostics/probe.ts'
import { install_weixin_connector } from './runtime/weixinConnector.ts'

/** Cordis function-plugin 名称。 */
export const name = 'webhook-weixin'
/**
 * 连接器所需的 Harness 原生服务。
 * 重构设计要求（§8.2）：依赖必须在装配期声明，缺失时**启动即失败**，
 * 而不是等第一条消息到达才暴露。
 */
export const inject = ['agents', 'agentPresets', 'sessionPersistence']

/** 微信连接器配置；token 由部署层注入，不提交到仓库。 */
export interface Config {
  base_url: string
  token: string
  cdn_base_url?: string
  /** 旧版状态文件路径；仅用于一次性迁移到 SQLite，迁移后只读保留。 */
  state_file?: string
  workspace_path: string
  provider: string
  model: string
  reasoning_effort?: string
  /** Agent 预设 id：决定该微信 Agent 能挂到哪些工具。 */
  agent_preset?: string
  send_retry_count?: number
  send_retry_delay_ms?: number
  /** SQLite 状态库路径；缺省为 $DSH_HOME/weixin-state.db。 */
  state_db?: string
  /** lease 标记文件（诊断）。 */
  lease_marker?: string
}

/** Schemastery 配置定义，保持模型/API 配置与代码分离。 */
export const Config: z<Config> = z.object({
  base_url: z.string().required(),
  token: z.string().role('secret').required(),
  cdn_base_url: z.string(),
  state_file: z.string(),
  workspace_path: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  reasoning_effort: z.string(),
  agent_preset: z.string(),
  send_retry_count: z.number(),
  send_retry_delay_ms: z.number(),
  state_db: z.string(),
  lease_marker: z.string(),
})

/** 注册微信连接器，并把长轮询与生命周期交给 Cordis effect。 */
export function apply(ctx: Context, config: Config): void {
  if (!config.base_url.startsWith('http')) throw new Error('webhook-weixin base_url must be an HTTP URL')
  if (!config.token.trim()) throw new Error('webhook-weixin token must be non-empty')
  probe('lifecycle', 'plugin.apply', {
    base_url: config.base_url,
    preset: config.agent_preset ?? '(default)',
    provider: config.provider,
    model: config.model,
    state_db: config.state_db ?? '(default)',
  })
  install_weixin_connector(ctx, config as unknown as Parameters<typeof install_weixin_connector>[1])
}
