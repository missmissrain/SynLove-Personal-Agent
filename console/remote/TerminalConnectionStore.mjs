/**
 * 终端管理桥接：GUI只调用独立终端管理器，不保存另一份设备、心跳或通知状态。
 * 参数project为主项目根目录；管理凭据来自私有config/terminalConnection.json。
 * 默认仅允许本机17864接口，请求期限8秒，拒绝重定向和非回环地址。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export class TerminalConnectionStore {
  /** project为主项目目录，不在构造时连接网络或创建设备数据。 */
  constructor({ project }) { this.project = project }

  /** 无参数；读取私有桥接配置，校验管理端点，不向浏览器返回令牌。 */
  read_bridge() {
    const data = JSON.parse(readFileSync(join(this.project, 'config', 'terminalConnection.json'), 'utf8').replace(/^\uFEFF/, ''))
    const url = new URL(data.adminURL ?? 'http://127.0.0.1:17864')
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) ||
      typeof data.adminToken !== 'string' || !data.adminToken) throw new Error('终端管理配置无效')
    return { ...data, adminURL: url.origin }
  }

  /** method/path/data为固定管理请求；不重试写操作，读取限制为1MiB。 */
  async request_json(method, path, data) {
    const cfg = this.read_bridge()
    const response = await fetch(`${cfg.adminURL}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${cfg.adminToken}`, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    if (!response.ok) throw new Error(`终端管理请求失败（${response.status}）`)
    let size = 0
    const chunks = []
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 1048576) throw new Error('终端管理响应过大')
      chunks.push(chunk)
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (result.ok !== true) throw new Error('终端管理器未确认请求')
    return result
  }

  /** 无参数；从同一权威服务读取设备、健康与接入类型，计算当前在线数量。 */
  async list_devices() {
    const [devices, health, types] = await Promise.all([
      this.request_json('GET', '/v1/devices'),
      this.request_json('GET', '/v1/health'),
      this.request_json('GET', '/v1/deviceTypes'),
    ])
    return { devices: devices.devices, relayConnected: health.relayConnected,
      notificationsConfigured: health.notificationsConfigured === true,
      onlineCount: devices.devices.filter(row => row.online).length,
      kinds: types.kinds, transports: types.transports }
  }

  /** data为设备名称、启用与通知设置；只转发管理员可编辑字段。 */
  async save_device(data) {
    return this.request_json('POST', '/v1/device', {
      id: data.id, name: data.name, enabled: data.enabled, settings: data.settings,
    })
  }

  /** data为登记字段，pair表示生成配对文件；预留设备只执行登记。 */
  async register_device(data, pair = false) {
    return this.request_json('POST', pair ? '/v1/pair' : '/v1/device/reserve', {
      deviceId: data.deviceId, name: data.name, kind: data.kind,
      transport: data.transport, parentId: data.parentId,
    })
  }

  /** id为设备ID；提交一次固定协议探活，轮询同一指令，不重复派发。 */
  async probe_device(id) {
    const created = await this.request_json('POST', '/v1/commands', {
      deviceId: id, command: { type: 'probe' },
    })
    const deadline = Date.now() + 35000
    while (Date.now() < deadline) {
      const row = await this.request_json('GET', `/v1/commands/${encodeURIComponent(created.id)}`)
      if (row.state === 'done') return {
        available: row.result?.ok === true && row.result?.protocol === 'synlove-terminal-v1',
        requestId: created.id,
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    return { available: false, pending: true, requestId: created.id }
  }

  /** 无参数；被动读取管理器健康，不另起SSH探测或维护在线副本。 */
  async refresh_devices() { return this.request_json('GET', '/v1/health') }
}
