/**
 * 服务只读探活：区分运行、按需待机、未启用远程存储、禁用与故障。
 * 注册参数 env：环境变量，默认 process.env；readiness：音频启动条件检查器；
 * fetcher：HTTP客户端，默认 fetch。只探活，不启动服务、不触发模型或业务。
 */
import { BusinessEndpoint } from './BusinessEndpoint.mjs'

export class ServiceProbe {
  /** 参数 env/readiness/fetcher 为可注入依赖；请求默认最多等待2500毫秒。 */
  constructor({ env = process.env, readiness, fetcher = fetch, secret = () => '' } = {}) {
    this.env = env
    this.readiness = readiness
    this.fetcher = fetcher
    this.secret = secret
    this.business = new Set(['core', 'reminders', 'digest', 'video', 'history', 'coding',
      'crawler', 'memory', 'state', 'qqstate', 'observation', 'session'])
    this.optional = new Set(['memory', 'state', 'qqstate', 'observation', 'session'])
  }

  /** 参数 name/cfg 为注册服务；返回真实可用性与原因，HTTP 200也必须匹配业务身份。 */
  async probe_service(name, cfg) {
    const prefix = `SYNLOVE_${name.toUpperCase()}`
    const endpoint = this.env[`${prefix}_BASE_URL`] || cfg.baseURL
    const mode = this.env[`${prefix}_MANAGEMENT`] ||
      (this.env[`${prefix}_BASE_URL`] ? 'external' : cfg.management)
    const result = { name: name.toUpperCase(), up: false, available: false,
      location: cfg.transport === 'relay' || !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(endpoint)
        ? 'remote' : 'local',
      management: mode === 'managed' ? '本机托管' : '外部服务' }
    if (mode === 'disabled') return { ...result, readiness: 'disabled', detail: '已在配置中关闭' }
    try {
      const url = new URL(endpoint)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('invalid endpoint')
      }
      result.port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      const path = cfg.transport === 'relay' ? '/v1/capabilities' : cfg.healthPath || (this.business.has(name) ? `${url.pathname.replace(/\/$/, '')}/health`
        : name === 'opencode' ? '/global/health' : name === 'rsshub' ? '/healthz' : '/health')
      const headers = {}
      const key = this.env[cfg.apiKeyEnv] || (cfg.apiKeyRef === 'backendService' ? this.secret() : '')
      if (key) headers.Authorization = `Bearer ${key}`
      if (cfg.transport === 'relay' && this.business.has(name)) {
        const body = await new BusinessEndpoint({ ...cfg, baseURL: endpoint }, this.fetcher, key).read_status('/health')
        const ready = body.ok === true && body.service === name && body.protocol === 1
        return { ...result, up: ready, available: ready, readiness: ready ? 'running' : 'unavailable',
          detail: ready ? '远端功能协议检查通过' : '远端功能或依赖未就绪' }
      }
      const response = await this.fetcher(new URL(path, url.origin), {
        headers, redirect: 'error', signal: AbortSignal.timeout(2500),
      })
      if (!response.ok) {
        await response.body?.cancel()
        return { ...result, readiness: 'unavailable', detail: `健康检查返回 HTTP ${response.status}` }
      }
      if (cfg.transport === 'relay') {
        const body = await response.json()
        const capability = { tts: 'tts', asr: 'asr', llm: 'chat' }[name]
        const ready = capability && Array.isArray(body.capabilities) &&
          body.capabilities.some(item => item.name === capability &&
            Number(item.nodes) > 0 && Number(item.capacity) > 0)
        if (ready) {
          // 节点注册不代表上游推理可用；最近确定的基础设施故障要等真实成功才能解除。
          const query = `/v1/tasks?capability=${encodeURIComponent(capability)}&limit=5`
          const tasksResponse = await this.fetcher(new URL(query, url.origin), {
            headers, redirect: 'error', signal: AbortSignal.timeout(2500),
          })
          if (!tasksResponse.ok) {
            await tasksResponse.body?.cancel()
            return { ...result, readiness: 'unavailable', detail: '远端能力执行状态暂不可验证' }
          }
          const tasks = (await tasksResponse.json()).tasks
          if (!Array.isArray(tasks)) {
            return { ...result, readiness: 'unavailable', detail: '远端能力执行状态协议不匹配' }
          }
          const settled = tasks.find(item => item.capability === capability &&
            ['done', 'failed', 'expired'].includes(item.status))
          const infrastructureFailed = settled && (settled.status === 'expired' ||
            (settled.status === 'failed' &&
              /upstream_unreachable|upstream_(?:401|403|5\d\d)|upstream_empty|node_lost|timeout/i.test(settled.error || '')))
          if (infrastructureFailed) {
            return { ...result, readiness: 'unavailable',
              detail: '远端节点在线，但最近执行超时或上游故障，尚未验证恢复' }
          }
        }
        return { ...result, up: Boolean(ready), available: Boolean(ready),
          readiness: ready ? 'running' : 'unavailable',
          detail: ready ? '远端节点能力已就绪' : '中转可达，但没有在线节点提供此能力' }
      }
      if (this.business.has(name) || name === 'tts' || name === 'asr') {
        const body = await response.json()
        const identity_ok = this.business.has(name)
          ? body.ok === true && body.service === name && body.protocol === 1
          : body.ok === true
        if (!identity_ok) {
          return { ...result, readiness: 'unavailable', detail: '端点响应与服务身份不匹配' }
        }
      } else if (name === 'opencode') {
        const body = await response.json()
        if (body.healthy !== true) return { ...result, readiness: 'unavailable', detail: '编程服务健康检查未通过' }
      } else {
        await response.body?.cancel()
      }
      return { ...result, up: true, available: true, readiness: 'running', detail: '服务已就绪' }
    } catch (error) {
      const refused = error?.cause?.code === 'ECONNREFUSED'
      if (refused) {
        // 灯亮的标准是"这个服务能不能用"，不是"现在在不在跑"。
        // 按需服务（TTS/ASR/本地大模型）健康接口没监听，但本机依赖与模型齐备、
        // 调用时会自动拉起 —— 这种情况仍然算可用，亮绿灯并标注"按需待机"。
        if (await this.readiness?.assess(name, { ...cfg, baseURL: endpoint, management: mode })) {
          return { ...result, available: true, readiness: 'standby',
            detail: '按需启动：本机依赖与模型已就绪，调用时自动拉起' }
        }
      }
      if (mode === 'managed' && refused) {
        if (this.optional.has(name) && (this.env[`${prefix}_MODE`] || cfg.mode || 'local') === 'local') {
          return { ...result, readiness: 'inactive', detail: '当前使用本地存储，独立远程接口未启用' }
        }
        if (['digest', 'video', 'history', 'coding', 'crawler'].includes(name)) {
          return { ...result, readiness: 'pending', detail: '尚未启动，工具调用时由服务管理器尝试启动' }
        }
        return { ...result, readiness: 'unavailable', detail: name === 'core'
          ? '独立核心控制接口尚未启动；本机控制台可直接管理后端'
          : '本机服务尚未就绪，请检查启动日志或依赖' }
      }
      return { ...result, readiness: 'unavailable', detail: mode === 'external'
        ? '远程健康检查失败，请检查网络、鉴权或服务状态' : '健康检查失败，请检查配置、依赖或响应格式' }
    }
  }
}
