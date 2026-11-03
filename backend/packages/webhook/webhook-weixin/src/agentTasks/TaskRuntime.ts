/**
 * 任务调度唯一所有者：创建独立执行会话、限制并发、真实取消、恢复中断任务与结果待办。
 * 参数来自 config/agentTaskConfig.json；默认两个后台任务，主人格仅可使用五个任务 MCP 工具。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { probe } from '../diagnostics/probe.ts'
import { TaskStore } from './TaskStore.ts'
import { TaskMcpServer } from './TaskMcpServer.ts'
import { WorkerSessionFactory } from './WorkerSessionFactory.ts'
import { TaskResultCollector } from './TaskResultCollector.ts'
import { PresenterEventBridge } from './PresenterEventBridge.ts'
import { delete_session_artifacts, sessions_root } from '../session/sessionFiles.ts'

export class TaskRuntime {
  static instances = new WeakMap<object, TaskRuntime>()
  store: TaskStore
  mcp: TaskMcpServer
  factory: WorkerSessionFactory
  collector = new TaskResultCollector()
  bridge: PresenterEventBridge
  config: any
  active = new Map<string, any>()
  channels = new Map<string, any>()
  attached = new WeakSet<object>()
  owner = randomUUID()
  ready: Promise<void>
  timer: any
  stopped = false
  pumping = false
  closing?: Promise<void>
  runs = new Set<Promise<void>>()
  worker_setup?: (ctx: any, task: any) => void
  /** ctx 为宿主，root 为生产路径，config 为已读取本机参数；tests 可注入 factory。 */
  constructor(private ctx: any, public root: string, config: any, factory?: any) {
    this.config = { maxConcurrent: 2, taskTimeoutMs: 1800000, presentationTimeoutMs: 90000, ...config }
    if (!Number.isInteger(this.config.maxConcurrent) || this.config.maxConcurrent < 1 || this.config.maxConcurrent > 4)
      throw new Error('任务并发必须为1至4')
    this.store = new TaskStore(join(root, 'runtime', 'agentTasks', 'taskStore.sqlite'))
    if (!this.store.claim_lease(this.owner)) { this.store.close_store(); throw new Error('另一个实例占用后台任务运行器') }
    this.store.recover_tasks()
    this.factory = factory ?? new WorkerSessionFactory(ctx, root, this.config, (child, task) => this.worker_setup?.(child, task))
    this.mcp = new TaskMcpServer(this)
    this.bridge = new PresenterEventBridge(this)
    this.ready = this.mcp.start_server()
    this.timer = setInterval(() => {
      if (!this.store.claim_lease(this.owner)) {
        void this.close_runtime()
        return
      }
      void this.pump_tasks().catch(error => this.log_event('pump.failed', { error: String(error) }))
    }, 2000)
    this.timer.unref?.()
  }
  /** ctx.root 为共享身份；配置关闭或纯测试未配置时保持原链路。 */
  static for_host(ctx: any, options: any): TaskRuntime | undefined {
    if (typeof ctx.effect !== 'function') return undefined
    const root = process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd()
    const path = join(root, 'config', 'agentTaskConfig.json')
    if (!existsSync(path)) return undefined
    const config = JSON.parse(readFileSync(path, 'utf8'))
    if (!config.enabled) return undefined
    const key = ctx.root ?? ctx.agents
    let runtime = this.instances.get(key)
    if (!runtime) {
      runtime = new TaskRuntime(ctx, root, config)
      this.instances.set(key, runtime)
      const current = runtime
      ;(ctx.root ?? ctx).effect(() => () => current.close_runtime())
    }
    return runtime
  }
  /** session 为主会话ID；通道回调判断是否为自动结果处理轮次。 */
  is_presenting(session: string): boolean { return this.bridge.is_presenting(session) }
  /** 无参数；旧租约或已停止实例不能继续提交状态。 */
  assert_owner(): void {
    if (this.stopped || !this.store.has_lease(this.owner)) throw new Error('后台任务运行器已停止或失去所有权')
  }
  /** kind 为事件名，data 仅包含任务元数据，不输出用户正文、地址或凭据。 */
  log_event(kind: string, data: any): void { probe('agent-task', kind, data) }
  /** channel 为真实通道，handler 由该通道装配，模型不能设置。 */
  register_channel(channel: string, handler: any): void { this.channels.set(channel, handler) }
  /** options 为部署模型路由，workspace 为部署目录；无模型调用地验证真实执行预设并清理探针会话。 */
  async check_worker(options: any, workspace: string): Promise<number> {
    const id = `task-check-${randomUUID()}`
    let handle: any
    try {
      handle = await this.factory.create_worker({ worker:id, kind:'research', origin:{workspace} }, options)
      const names = handle.agent.ctx.tools.schemas(handle.agent).map((tool: any) => tool.name)
      if (!names.includes('read') || names.some((name: string) => ['write','edit','pwsh','bash','codex','opencode'].includes(name)))
        throw new Error('只读执行预设工具边界不符合配置')
      return names.length
    } finally {
      await handle?.dispose()
      delete_session_artifacts({ root:sessions_root(), cwd:workspace, id })
    }
  }
  /** agent 为主会话，origin 为宿主构造的不可变发送目标；返回注入消息的来源ID。 */
  note_input(agent: any, origin: any): string {
    const key = `${origin.channel}:${origin.messageId}`
    this.store.save_origin(key, String(agent.id), { ...origin, sessionId: String(agent.id) })
    return key
  }
  /** agent 为新建或恢复主人格；限制对真实调用生效，而不是只隐藏工具名。 */
  async attach_presenter(agent: any, options: any): Promise<void> {
    if (this.attached.has(agent)) return
    await this.ready
    this.attached.add(agent)
    const token = this.mcp.bind_owner({ agent, options, session: String(agent.id) })
    try {
      agent.ctx.tools.presentAs('native')
      await McpClient.apply(agent.ctx, {
        transport: 'streamable-http', serverName: 'synlove-task', url: this.mcp.url,
        headers: { Authorization: `Bearer ${token}` }, failOnStartupError: true, toolCallTimeoutMs: 15000,
        registerResources: false,
      } as any)
      const allow = this.mcp.list_tools().map(tool => `mcp__synlove-task__${tool.name}`)
      agent.ctx.tools.restrict({ allow: [] })
      agent.ctx.tools.guard((exec: any) => allow.includes(exec.name) ? undefined : '主人格只能使用任务 MCP')
      agent.ctx.on('system-prompt/assemble', async (_assembly: any, _context: any, next: any) => {
        const assembly = await next()
        return { ...assembly, sections: assembly.sections.filter((section: any) =>
          section.name !== 'mcp-resource-servers'
          && (!section.name.startsWith('mcp:') || section.name === 'mcp:synlove-task')) }
      })
      agent.ctx.systemPrompt.section({
        name: 'synlove:presenter-protocol',
        order: 100000,
        text: readFileSync(join(this.root, 'prompts', 'PresenterProtocol.md'), 'utf8'),
      })
      agent.ctx.effect(() => () => this.mcp.revoke_owner(token))
      this.log_event('presenter.ready', { tools: allow.length })
    } catch (error) { this.attached.delete(agent); this.mcp.revoke_owner(token); throw error }
  }
  /** owner 为会话令牌绑定对象；取最近真实用户消息的来源，不让完成事件取得提交权限。 */
  current_origin(owner: any, id?: string, unique = false): any {
    const events = owner.agent.session.snapshotEvents()
    const origins: any[] = []
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn/start') break
      if (events[i].type !== 'user/message') continue
      const source = events[i].data?.source
      if (source?.kind === 'synlove-task-result') throw new Error('结果处理轮次不能启动或修改任务')
      // time-context / system-prompt 等插件会在每轮注入 form=snapshot 的上下文快照，
      // 它们不是真实用户输入，没有 taskOriginId，必须跳过（否则任务工具永远被拒）。
      if (source?.form === 'snapshot') continue
      const key = source?.taskOriginId
      if (!key) throw new Error('当前消息没有可信通道来源，拒绝后台操作')
      const origin = this.store.get_origin(key, owner.session)
      if (!origin) throw new Error('消息来源已失效')
      origins.push({ ...origin, key })
    }
    if (!origins.length) throw new Error('尚未绑定用户输入')
    if (id !== undefined) {
      const origin = origins.find(item => item.key === id)
      if (!origin) throw new Error('originId 不属于本轮可信入站消息')
      return origin
    }
    if (unique && new Set(origins.map(item => `${item.channel}:${item.userId ?? ''}:${JSON.stringify(item.target)}`)).size > 1)
      throw new Error('本轮有多个消息来源，请用 originId 指定原消息：' + JSON.stringify(
        origins.map(item => ({ originId:item.key, channel:item.channel, request:item.originalText?.slice(0,300) }))))
    return origins[0]
  }
  /** owner 来自能力令牌，name 与 args 为已验证的五工具请求。 */
  async call_tool(owner: any, name: string, args: any): Promise<any> {
    this.assert_owner()
    const definition = this.mcp.list_tools().find(tool => tool.name === name)
    if (!definition) throw new Error('未知任务工具')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('不允许的任务参数')
    const unexpected = Object.keys(args).filter(key => !Object.hasOwn(definition.inputSchema.properties, key))
    if (unexpected.length) {
      // 常见混淆：把补充要求（task_message 的 message/taskId）塞进 task_submit。
      const hint = name === 'task_submit' && (args.taskId || args.message)
        ? '；给进行中的任务补充要求请改用 task_message（参数 taskId + message），task_submit 只用于新建任务（必填 request）'
        : `；本工具（${name}）只接受参数：${Object.keys(definition.inputSchema.properties).join(', ')}`
      throw new Error(`不允许的任务参数：${unexpected.join(', ')}${hint}`)
    }
    const presentation = this.is_presenting(owner.session)
    if (presentation && name !== 'task_result') throw new Error('自动结果轮次只允许读取总结')
    if (args.originId !== undefined && (typeof args.originId !== 'string' || args.originId.length > 512))
      throw new Error('originId 无效')
    const origin = presentation ? undefined : this.current_origin(owner, args.originId, name === 'task_submit')
    const scope = origin?.owner ?? owner.session
    if (name === 'task_submit') {
      if (typeof args.request !== 'string' || !args.request.trim() || args.request.length > 12000) throw new Error('任务要求必须为1至12000字符')
      const kind = args.kind ?? 'operations'
      if (!['research','coding','operations'].includes(kind)) throw new Error('未知任务类别')
      const key = createHash('sha256').update(`${scope}\n${origin.key}\n${args.request.trim()}`).digest('hex')
      const task = this.store.create_task(scope, key,
        { ...origin, options: owner.options, workspace: origin.workspace ?? owner.options.workspace_path },
        args.request.trim(), kind)
      setImmediate(() => { void this.pump_tasks().catch(error => this.log_event('start.failed', { error: String(error) })) })
      return { taskId: task.id, state: task.state, accepted: true,
        replyInstruction: '请现在用自己的自然语气告知用户任务已交给后台；不要等待或轮询，结束后会主动通知。不得把已接收说成已经完成。' }
    }
    if (args.taskId !== undefined && (typeof args.taskId !== 'string' || !args.taskId || args.taskId.length > 80))
      throw new Error('任务ID无效')
    const id = typeof args.taskId === 'string' ? args.taskId : ''
    if (name === 'task_status' && !id)
      return this.store.list_tasks(scope).map(task => ({ taskId: task.id, state: task.state, kind: task.kind, updatedAt: task.updated }))
    let task: any
    if (presentation) {
      const activeId = this.bridge.active.get(owner.session)?.taskId
      if (id !== activeId) throw new Error('自动结果轮次不能读取其他任务')
      task = this.store.get_task(id, this.bridge.active.get(owner.session).owner)
    } else task = this.store.get_task(id, scope)
    if (name === 'task_status') return { taskId: id, state: task.state, workerSessionId: task.worker, updatedAt: task.updated }
    if (name === 'task_result') {
      const offset = args.offset ?? 0
      if (!Number.isInteger(offset) || offset < 0) throw new Error('结果偏移必须为非负整数')
      const result = task.result ?? '任务尚未形成最终总结。'
      return { taskId: id, state: task.state, summary: result.slice(offset, offset + 10000),
        nextOffset: offset + 10000 < result.length ? offset + 10000 : null,
        verification: '以执行总结中的实际验证范围为准；会话结束不等于所有目标均已验证' }
    }
    const run = this.active.get(id)
    if (name === 'task_cancel') {
      if (task.state === 'queued') this.store.update_task(id, { state: 'cancelled', result: '任务在启动前已取消，没有开始执行。' })
      else if (run && task.state === 'running') {
        this.store.update_task(id, { state: 'cancelling' })
        run.cancelled = true
        run.abort.abort(new Error('用户请求取消任务'))
        run.handle?.agent.cancel({ kind: 'user' })
      }
      return { taskId: id, state: this.store.get_task(id, scope).state }
    }
    if (name === 'task_message') {
      if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 12000) throw new Error('补充要求必须为1至12000字符')
      if (!run?.handle || task.state !== 'running') throw new Error('任务当前不可追加；会话尚未就绪或任务已经结束')
      run.handle.agent.steer(createUserMessage({
        content: [{ type: 'text', text: args.message }], source: { kind: 'user' },
      }))
      return { taskId: id, accepted: true, effective: '在执行器下一模型步骤读取，正在运行的外部命令不会被强制重做' }
    }
  }
  /** 无参数；并发有界，同一可写工作区只运行一个任务，完成通知独立于执行名额。 */
  async pump_tasks(): Promise<void> {
    if (this.stopped || this.pumping) return
    this.pumping = true
    try {
      this.assert_owner()
      for (const task of this.store.pending_tasks('work')) {
        if (task.state !== 'queued' || this.active.size >= this.config.maxConcurrent) continue
        if ([...this.active.values()].some(run => run.task.origin.workspace === task.origin.workspace
          && (run.task.kind !== 'research' || task.kind !== 'research'))) continue
        const entry: any = { task, handle: undefined, cancelled: false, abort: new AbortController() }
        this.active.set(task.id, entry)
        this.store.update_task(task.id, { state: 'running' })
        const work = this.run_task(entry)
        this.runs.add(work)
        void work.finally(() => this.runs.delete(work))
      }
      void this.bridge.pump_results().catch(error => this.log_event('notice.failed', { error: String(error) }))
    } finally { this.pumping = false }
  }
  /** entry 为唯一执行登记；超时取消、不自动重放副作用，并始终保存结果。 */
  async run_task(entry: any): Promise<void> {
    const task = entry.task
    const timer = setTimeout(() => {
      entry.cancelled = true
      entry.timeout = true
      entry.abort.abort(new Error('后台任务超时'))
      entry.handle?.agent.cancel({ kind: 'timeout' })
    }, this.config.taskTimeoutMs)
    try {
      entry.handle = await this.factory.create_worker(task, task.origin.options, entry.abort.signal)
      this.assert_owner()
      if (this.stopped || entry.cancelled) entry.handle.agent.cancel({ kind: 'host' })
      else {
        entry.handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: [
            `任务ID：${task.id}；类别：${task.kind}；获准工作区：${task.origin.workspace}。`,
            `用户本次原文（约束不能丢失）：${task.origin.originalText ?? ''}`,
            `具体任务：${task.request}`,
            '不要向用户直接发消息；执行完给出完整最终总结，包含实际完成、验证、产物、风险与未完成项。',
          ].join('\n') }],
          source: { kind: 'user' },
        }))
        await entry.handle.agent.whenIdle()
      }
      const result = this.collector.collect_result(entry.handle.agent, 0, entry.cancelled, true)
      await entry.handle.dispose()
      entry.handle = undefined
      this.assert_owner()
      this.store.update_task(task.id, { state: entry.timeout ? 'interrupted' : result.state,
        result: (entry.timeout ? '任务超时，已请求取消；不能确认外部操作全部停止。\n' : '') + result.result })
    } catch (error) {
      if (!this.stopped && this.store.has_lease(this.owner))
        this.store.update_task(task.id, { state: entry.timeout ? 'interrupted' : entry.cancelled ? 'cancelled' : 'failed',
          result: `后台执行${entry.cancelled ? '已请求停止；外部副作用需核对' : '失败'}：${String(error).slice(0, 1000)}` })
    } finally {
      clearTimeout(timer)
      try { await entry.handle?.dispose() } catch {}
      this.active.delete(task.id)
      this.log_event('task.ended', { taskId: task.id })
      if (!this.stopped) void this.pump_tasks().catch(() => {})
    }
  }
  /** 无参数；先停止接单并取消实际会话，结果待办保留供下次启动补投。 */
  async close_runtime(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    clearInterval(this.timer)
    for (const run of this.active.values()) {
      run.cancelled = true
      run.abort.abort(new Error('后台任务宿主停止'))
      run.handle?.agent.cancel({ kind: 'host' })
    }
    this.closing = (async () => {
      await this.mcp.close_server()
      await Promise.allSettled([...this.runs])
      await this.bridge.close_bridge()
      this.store.release_lease(this.owner)
      this.store.close_store()
    })()
    return this.closing
  }
}
