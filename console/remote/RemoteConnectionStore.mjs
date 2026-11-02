/**
 * 远程连接配置：管理本机目标及私密凭据，调用固定探测桥，不执行任意命令。
 * 注册参数 project 为生产根目录，python 为可执行文件，runner 为可注入隔离测试替身。
 * 密码留空保留原值；GET 不回传密码；所有文件按严格 JSON 解析并原子替换。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export class RemoteConnectionStore {
  /** 参数 project/python/runner 分别为生产根目录、解释器和可选探测替身。 */
  constructor({ project, python, runner } = {}) {
    this.project = project
    this.python = python
    this.runner = runner ?? (body => this.run_worker(body))
    this.active = 0
  }

  /** 参数 name/fallback 为固定配置文件名和缺省值；损坏配置不得被空配置覆盖。 */
  read_json(name, fallback) {
    const path = join(this.project, 'config', name)
    if (!existsSync(path)) return fallback
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本机配置格式错误')
    return value
  }

  /** 参数 name/value 为固定配置文件名和对象；不在异常中包含正文或密钥。 */
  write_json(name, value) {
    const path = join(this.project, 'config', name)
    const privateDir = join(this.project, 'runtime', 'remoteControl', 'configWrite')
    mkdirSync(privateDir, { recursive: true })
    const temp = join(privateDir, `${name}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, path)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  }

  /** 参数 host/port 为地址和独立端口；只接受主机名或 IP，禁止 URL/凭据/命令注入。 */
  validate_endpoint(host, port) {
    if (typeof host !== 'string' || !host || host.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(host)) {
      throw new Error('请填写 IP 或主机名，不含 http、路径或端口')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口须为 1 至 65535 的整数')
  }

  /** 无参数；返回界面可编辑字段和密码存在标志，不返回凭据正文或私钥路径。 */
  list_targets() {
    const data = this.read_json('remoteControl.json', { targets: {} })
    const secrets = this.read_json('secrets.json', {})
    let status = {}
    try { status = JSON.parse(readFileSync(join(this.project, 'runtime', 'remoteControl', 'channelStatus.json'), 'utf8')) } catch {}
    const version = this.config_version()
    return { ok: true, targets: Object.entries(data.targets ?? {}).map(([id, item]) => ({
      id, description: item.description ?? '', host: item.host ?? '', port: item.port ?? 22,
      user: item.user ?? '', hostKeySha256: item.hostKeySha256 ?? '', enabled: item.enabled === true,
      hasCredential: Boolean(secrets.remoteControl?.targets?.[id]?.password ||
        secrets.remoteControl?.targets?.[id]?.privateKeyPath),
      available: item.enabled === true && status[id]?.available === true &&
        status[id].version === version && Date.now() - status[id].checkedAt >= 0 &&
        Date.now() - status[id].checkedAt < 60000,
      checkedAt: status[id]?.version === version ? status[id].checkedAt : 0,
    })) }
  }

  /** 参数 body 为目标表单；别名不可含路径，主机变更或指纹变更必须由用户确认身份。 */
  save_target(body) {
    const id = body.id
    if (typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(id)) throw new Error('电脑标识请使用英文字母和数字，以字母开头')
    this.validate_endpoint(body.host, body.port)
    if (typeof body.user !== 'string' || !body.user.trim() || body.user.length > 128 || /[\r\n\0]/.test(body.user)) throw new Error('请填写目标电脑的登录账号')
    if (typeof body.enabled !== 'boolean') throw new Error('启用状态不正确')
    if (typeof body.password !== 'string' || body.password.length > 4096) throw new Error('密码格式不正确')
    const fingerprint = String(body.hostKeySha256 ?? '').trim()
    if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) throw new Error('请先获取并核对 SSH 指纹')
    const data = this.read_json('remoteControl.json', { targets: {} })
    data.targets ??= {}
    const prior = data.targets[id]
    const identityChanged = !prior || prior.host !== body.host || prior.port !== body.port || prior.hostKeySha256 !== fingerprint
    if (identityChanged && body.trustConfirmed !== true) throw new Error('请核对目标电脑 SSH 指纹并勾选确认')
    const secrets = this.read_json('secrets.json', {})
    secrets.remoteControl ??= {}
    secrets.remoteControl.targets ??= {}
    const credential = { ...(secrets.remoteControl.targets[id] ?? {}) }
    if (body.password) {
      credential.password = body.password
      delete credential.privateKeyPath
      delete credential.passphrase
    }
    if (body.enabled && !credential.password && !credential.privateKeyPath) throw new Error('启用前请填写目标电脑登录密码')
    secrets.remoteControl.targets[id] = credential
    const target = { ...(prior ?? {}), host: body.host, port: body.port, user: body.user.trim(),
      enabled: body.enabled, description: String(body.description ?? '').slice(0, 120), hostKeySha256: fingerprint }
    // 改目标时不能沿用旧地址的 known_hosts；本界面使用显式核对的指纹。
    delete target.knownHostsPath
    data.targets[id] = target
    this.write_json('secrets.json', secrets)
    this.write_json('remoteControl.json', data)
    return this.list_targets()
  }

  /** 参数 id 为明确选中的目标；仅删除本机连接配置及其凭据，不操作远端电脑。 */
  delete_target(id) {
    const data = this.read_json('remoteControl.json', { targets: {} })
    if (!Object.hasOwn(data.targets ?? {}, id)) throw new Error('目标电脑不存在')
    const secrets = this.read_json('secrets.json', {})
    delete data.targets[id]
    if (secrets.remoteControl?.targets) delete secrets.remoteControl.targets[id]
    this.write_json('remoteControl.json', data)
    this.write_json('secrets.json', secrets)
    return this.list_targets()
  }

  /** 参数 body 为只读探测请求；限制并发，不探测未保存的登录密码。 */
  async probe_target(body) {
    if (this.active >= 2) throw new Error('已有连接测试正在进行，请稍候')
    if (body.action === 'peekKey') this.validate_endpoint(body.host, body.port)
    else if (body.action === 'probe') {
      if (!this.list_targets().targets.some(item => item.id === body.target && item.enabled)) throw new Error('请先保存并启用目标电脑')
    } else throw new Error('未知连接检查')
    this.active += 1
    const version = this.config_version()
    try {
      const result = await this.runner(body)
      if (body.action === 'probe') this.save_probe_status(body.target, result.available === true, version)
      return result
    } catch (error) {
      if (body.action === 'probe') this.save_probe_status(body.target, false, version)
      throw error
    } finally { this.active -= 1 }
  }

  /** 无参数；用配置文件修改时间使旧探活结果在配置变化后立即失效，不散播凭据。 */
  config_version() {
    return ['remoteControl.json', 'secrets.json'].map(name => {
      const file = join(this.project, 'config', name)
      return existsSync(file) ? statSync(file).mtimeMs : 0
    }).join(':')
  }

  /** 参数 id/available/version 为目标及真实探活证据；仅写本机观测，不充当配置源。 */
  save_probe_status(id, available, version) {
    const dir = join(this.project, 'runtime', 'remoteControl')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'channelStatus.json')
    let status = {}
    try { status = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 观测丢失可重建 */ }
    status[id] = { available, version, checkedAt: Date.now() }
    const temp = join(dir, `${randomUUID()}.tmp`)
    try { writeFileSync(temp, JSON.stringify(status)); renameSync(temp, file) }
    finally { if (existsSync(temp)) unlinkSync(temp) }
  }

  /** 参数 body 为固定动作；通过 stdin 传输，进程参数和日志不携带密码。 */
  run_worker(body) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [join(this.project, 'remoteControl', 'RemoteControlAdmin.py')], {
        cwd: this.project, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = '', failed = false
      const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('连接检查超时，未自动重试')) }, 60_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', text => {
        if (failed) return
        output += text
        if (output.length > 65536 && !failed) { failed = true; child.kill(); reject(new Error('连接检查响应过大')) }
      })
      child.stderr.resume()
      child.stdin.on('error', () => {})
      child.on('error', () => { clearTimeout(timer); if (!failed) reject(new Error('远控解释器无法启动，请检查安装依赖')) })
      child.on('close', code => {
        clearTimeout(timer)
        if (failed) return
        try {
          if (code !== 0) throw new Error()
          resolve(JSON.parse(output))
        } catch { reject(new Error('远控检查未返回有效结果')) }
      })
      child.stdin.end(JSON.stringify(body))
    })
  }
}
