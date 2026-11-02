/**
 * DashboardStore：只读汇总后台动态、用户提醒、系统计划任务和既有微信/QQ 消费者状态。
 * 构造参数 project：链路根目录；home：DSH_HOME；credentials：凭据配置标志；tasks：计划任务查询器；musicProbe：可选的音乐服务测试探针。
 * 默认每 60 秒缓存系统计划任务；增量读取探针，每次最多 8MiB，不创建连接器、不修改业务库。
 */
import { DatabaseSync } from 'node:sqlite'
import { openSync, readSync, closeSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

export class DashboardStore {
  /** 参数 options：项目根目录、状态目录和可选依赖；初始化仅用于展示的读取游标与缓存。 */
  constructor({ project, home, credentials = () => ({}), tasks, musicProbe } = {}) {
    this.project = project
    this.home = home
    this.credentials = credentials
    this.tasks = tasks ?? (() => this.query_windows_tasks())
    this.musicProbe = musicProbe
    this.offset = 0
    this.pending = ''
    this.events = new Map()
    this.taskCache = null
    this.taskAt = 0
    this.taskPending = null
  }

  /** 参数 file/fallback：JSON 文件及失败默认值；读取配置时不向界面暴露整个原文。 */
  read_json(file, fallback = {}) {
    try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
  }

  /** 参数 file/sql：固定路径和内部 SQL；以只读方式查询 SQLite，缺文件不创建新库。 */
  read_rows(file, sql) {
    if (!existsSync(file)) return []
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout=200')
      return db.prepare(sql).all()
    } finally { db.close() }
  }

  /** 参数 pid：已有进程号；只检查存活，不启动或终止任何进程。 */
  process_alive(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false
    try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
  }

  /** 无参数；增量读取探针，只保留需要展示的事件元数据，限制单次读取量和残行长度。 */
  read_probe() {
    const file = join(this.project, 'runtime', 'weixin-probe.log')
    if (!existsSync(file)) return
    const stat = statSync(file)
    if (stat.size < this.offset || (stat.size === this.offset && stat.mtimeMs !== this.probeMtime)) {
      this.offset = 0
      this.pending = ''
      this.events.clear()
    }
    if (stat.size === this.offset) return
    const max = 8 * 1024 * 1024
    let start = this.offset
    if (stat.size - start > max) { start = stat.size - max; this.pending = '' }
    const fileHandle = openSync(file, 'r')
    try {
      const bytes = Buffer.alloc(stat.size - start)
      const count = readSync(fileHandle, bytes, 0, bytes.length, start)
      let text = this.pending + bytes.subarray(0, count).toString('utf8')
      if (start > this.offset) text = text.slice(text.indexOf('\n') + 1)
      const lines = text.split('\n')
      this.pending = (lines.pop() ?? '').slice(-65536)
      for (const line of lines) {
        if (!/"event":/.test(line)) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (!Number.isFinite(Date.parse(row.at)) || typeof row.event !== 'string') continue
        if (!/^(poll\.|qq\.(gateway|health|send)|scheduler\.|summar|update\.|check\.done)/.test(row.event)) continue
        this.events.set(`${row.scope}:${row.event}`, {
          at: row.at, scope: row.scope, event: row.event,
          message: typeof row.data?.message === 'string' ? row.data.message.slice(0, 160) : '',
          interval: Number(row.data?.interval_ms) || undefined,
        })
      }
      this.offset = start + count
      this.probeMtime = stat.mtimeMs
    } finally { closeSync(fileHandle) }
  }

  /** 参数 rows：事件列表；取时间最新项，允许空列表返回 undefined。 */
  latest(rows) {
    return rows.reduce((last, row) => !last || Date.parse(row.at) >= Date.parse(last.at) ? row : last, undefined)
  }

  /** 无参数；读取现有租约、轮询证据与 QQ 网关日志，严格区分已连接、重连、待确认。 */
  channels() {
    const cfg = this.credentials()
    const rows = [...this.events.values()]
    let lease
    try {
      lease = this.read_rows(join(this.home, 'weixin-state.db'), 'SELECT pid, process_started_at, heartbeat_at FROM consumer_lease WHERE id = 1')[0]
    } catch { /* 没有租约时不能声称连接成功 */ }
    const live = lease && this.process_alive(Number(lease.pid)) && Date.now() - lease.heartbeat_at < 90_000
    const poll = this.latest(rows.filter(row => row.scope === 'ingress' && row.event.startsWith('poll.')))
    const wx = { id: 'weixin', tab: 'weixin', name: '微信', status: 'unknown', label: '待确认', detail: '暂无当前消费者的轮询证据' }
    if (!cfg.weixin) Object.assign(wx, { status: 'unconfigured', label: '未配置', detail: '请在微信绑定页扫码' })
    else if (!live) Object.assign(wx, { status: 'offline', label: '未连接', detail: '未发现活跃的消费者租约' })
    else if (poll && Date.parse(poll.at) >= lease.process_started_at && Date.now() - Date.parse(poll.at) < 120_000) {
      wx.lastEventAt = poll.at
      if (['poll.session_timeout', 'poll.auth_required'].includes(poll.event)) Object.assign(wx, { status: 'auth', label: '需要登录', detail: '当前消费者报告鉴权异常，请查看微信绑定页' })
      else if (['poll.idle', 'poll.messages', 'poll.long_poll_timeout'].includes(poll.event)) Object.assign(wx, { status: 'connected', label: '已连接', detail: '单消费者租约有效，最近轮询正常' })
      else Object.assign(wx, { status: 'reconnecting', label: '连接异常', detail: '当前消费者报告网络或协议异常' })
    }
    let qqPid = 0
    try { qqPid = Number(readFileSync(join(this.home, 'qq-gateway.pid'), 'utf8').trim()) } catch { /* 缺标记 */ }
    const qq = { id: 'qq', tab: 'qq', name: 'QQ 机器人', status: 'unknown', label: '待确认', detail: '尚未读取到当前网关的 READY 记录' }
    const gateway = this.latest(rows.filter(row => row.event === 'qq.gateway'))
    if (!cfg.qq) Object.assign(qq, { status: 'unconfigured', label: '未配置', detail: '请在 QQ 通道页填写机器人凭据' })
    else if (!this.process_alive(qqPid)) Object.assign(qq, { status: 'offline', label: '未连接', detail: 'QQ 网关进程不在运行' })
    else if (gateway && live && qqPid === Number(lease.pid) && Date.parse(gateway.at) >= lease.process_started_at) {
      qq.lastEventAt = gateway.at
      if (gateway.message === 'gateway READY' || /心跳已确认|已连接/.test(gateway.message)) Object.assign(qq, { status: 'connected', label: '已连接', detail: gateway.message === 'gateway READY' ? '现有网关已完成 READY 握手' : '现有网关持续收到心跳' })
      else Object.assign(qq, { status: 'reconnecting', label: '连接中', detail: /断开|失败|错误|失效|被踢|重连/.test(gateway.message) ? '网关正在恢复连接，请查看日志' : '等待 QQ 网关 READY' })
    }
    return [wx, qq]
  }

  /** 无参数；探测已配置的酷狗 API 首页，只读请求不启动服务、不登录、不播放音乐。 */
  async music_channel() {
    const row = { id: 'kugou', tab: 'agent', name: '酷狗音乐', status: 'offline', label: '未连接', detail: '音乐服务暂不可用' }
    const cfg = this.read_json(join(this.project, 'kugou', 'config', 'kugou.json'), null)
    if (!cfg) return { ...row, status: 'unconfigured', label: '未配置', detail: '尚未配置音乐服务' }
    if (cfg.enabled === false) return { ...row, status: 'disabled', label: '未启用', detail: '音乐功能已关闭' }
    try {
      const url = new URL(cfg.apiBase || 'http://127.0.0.1:3001')
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return row
      let up
      if (this.musicProbe) up = await this.musicProbe(url)
      else {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) })
        up = response.ok
        await response.body?.cancel()
      }
      return up ? { ...row, status: 'connected', label: '已连接', detail: 'KuGouMusicApi 服务可连接' } : row
    } catch { return row }
  }

  /** 无参数；通过只读系统命令查询与本项目有关的 Windows 任务，不执行任务动作。 */
  query_windows_tasks() {
    if (process.platform !== 'win32') return Promise.reject(new Error('当前系统没有 Windows 计划任务服务'))
    const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; @(Get-ScheduledTask | Where-Object {$_.TaskName -in @('SynLoveNewsDigest','SynLoveSkillReview','SynLoveGuard','SynLoveConsoleWatch')} | ForEach-Object {$i=Get-ScheduledTaskInfo -InputObject $_; [pscustomobject]@{id=$_.TaskName;state=[string]$_.State;nextAt=$i.NextRunTime.ToString('o');lastAt=$i.LastRunTime.ToString('o');result=$i.LastTaskResult;triggers=@($_.Triggers | ForEach-Object {[pscustomobject]@{start=$_.StartBoundary;interval=[string]$_.Repetition.Interval}})}}) | ConvertTo-Json -Depth 5 -Compress`
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 12_000, encoding: 'utf8', maxBuffer: 256 * 1024 }, (error, stdout) => {
          if (error) return reject(new Error('读取 Windows 计划任务失败'))
          try {
            const value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]')
            resolve(Array.isArray(value) ? value : [value])
          } catch { reject(new Error('Windows 计划任务返回格式无效')) }
        })
    })
  }

  /** 无参数；合并并发系统查询，60 秒内复用结果，失败状态也明确返回。 */
  async system_tasks() {
    if (this.taskCache && Date.now() - this.taskAt < 60_000) return this.taskCache
    if (this.taskPending) return this.taskPending
    this.taskPending = Promise.resolve().then(() => this.tasks()).then(
      rows => ({ rows, error: null }),
      () => ({ rows: [], error: '系统计划任务暂不可用' }),
    ).then(result => { this.taskCache = result; this.taskAt = Date.now(); return result })
      .finally(() => { this.taskPending = null })
    return this.taskPending
  }

  /** 无参数；按真实更新时间聚合技能、记忆、新闻推送、提醒投递与后台运行结果。 */
  activities() {
    const items = []
    const add = (id, at, text, kind = 'system') => {
      const date = new Date(at)
      if (Number.isFinite(date.getTime()) && date.getFullYear() >= 2000) items.push({ id, at: date.toISOString(), text, kind })
    }
    const runtime = join(this.project, 'runtime')
    try {
      const pushes = this.read_rows(join(runtime, 'newsDigest.db'), 'SELECT id, created_at, channel, ok FROM pushes ORDER BY id DESC LIMIT 8')
      for (const row of pushes) add(`push-${row.id}`, row.created_at, `新闻推送${row.ok ? '成功' : '失败'} · ${row.channel === 'qq' ? 'QQ' : row.channel === 'weixin' ? '微信' : '消息通道'}`, 'push')
    } catch { /* 单个来源失败不影响其他来源 */ }
    try {
      const reminders = this.read_rows(join(runtime, 'reminders.db'), 'SELECT id, fired_at FROM reminders WHERE fired_at IS NOT NULL ORDER BY fired_at DESC LIMIT 4')
      for (const row of reminders) add(`reminder-${row.id}`, row.fired_at, `提醒 #${row.id} 已执行投递流程`, 'push')
    } catch { /* 投递是否成功由对应日志或账本确认，不把 fired_at 说成成功 */ }
    const state = this.read_json(join(runtime, 'skill-review-state.json'))
    if (state.last_run_at) add('skill-review', state.last_run_at, `技能复盘完成 · 新增 ${Array.isArray(state.last_saved) ? state.last_saved.length : 0} 项 · 待审 ${Array.isArray(state.last_staged) ? state.last_staged.length : 0} 项`, 'skill')
    const skills = join(this.home, 'skills')
    if (existsSync(skills)) {
      for (const entry of readdirSync(skills, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, 200)) {
        const file = join(skills, entry.name, 'SKILL.md')
        if (existsSync(file)) add(`skill-${entry.name}`, statSync(file).mtime.toISOString(), `技能文件更新 · ${entry.name}`, 'skill')
      }
    }
    const timeline = this.read_json(join(this.home, 'timeline', 'index.json'))
    if (timeline.updated_at) add('timeline', timeline.updated_at, '时间线记忆索引已更新', 'memory')
    const graph = this.read_json(join(this.home, 'graph', 'index.json'))
    if (graph.updated_at) add('graph', graph.updated_at, '人物关系图谱已更新', 'memory')
    return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12)
  }

  /** 无参数；读取待触发的用户提醒，返回总数与前 20 项，查询失败不伪装为空。 */
  reminders() {
    const file = join(this.project, 'runtime', 'reminders.db')
    try {
      const total = this.read_rows(file, "SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending'")[0]?.n ?? 0
      const rows = this.read_rows(file, "SELECT id, text, next_at, daily_at FROM reminders WHERE status = 'pending' ORDER BY next_at LIMIT 20")
      return { total, rows: rows.map(row => ({ id: `reminder-${row.id}`, name: row.text, nextAt: row.next_at, rule: row.daily_at ? `每天 ${row.daily_at}` : '一次性', status: 'pending', source: '用户提醒' })), error: null }
    } catch { return { total: null, rows: [], error: '用户提醒数据库暂不可用' } }
  }

  /** 无参数；返回展示快照，所有查询只读，不复制业务调度器或消费者状态。 */
  async snapshot() {
    this.read_probe()
    const [system, music] = await Promise.all([this.system_tasks(), this.music_channel()])
    const reminders = this.reminders()
    const names = { SynLoveNewsDigest: '新闻摘要推送', SynLoveSkillReview: '技能复盘', SynLoveGuard: '后台健康巡检', SynLoveConsoleWatch: '控制台看护' }
    const tasks = system.rows.map(row => ({
      ...row, name: names[row.id] ?? row.id, source: '系统计划任务',
      rule: row.triggers?.[0]?.interval ? `每 ${row.triggers[0].interval.replace(/^PT/, '').replace('M', ' 分钟').replace('H', ' 小时')}` : row.triggers?.[0]?.start ? `每天 ${row.triggers[0].start.slice(11, 16)}` : '按系统触发器',
    }))
    const channels = this.channels()
    const running = channels.some(channel => channel.status === 'connected')
    for (const scope of ['timeline', 'graph']) {
      const event = this.latest([...this.events.values()].filter(row => row.scope === scope && ['scheduler.started', 'scheduler.stopped'].includes(row.event)))
      if (event?.event === 'scheduler.started' && event.interval) tasks.push({
        id: `maintenance-${scope}`, name: scope === 'timeline' ? '时间线摘要检查' : '关系图谱维护',
        source: 'Harness 后台', rule: `每 ${Math.round(event.interval / 60_000)} 分钟检查，满足空闲条件时执行`,
        status: running ? 'running' : 'Unknown', nextAt: null,
      })
    }
    const activities = this.activities()
    for (const task of system.rows) {
      const at = new Date(task.lastAt)
      if (Number.isFinite(at.getTime()) && at.getFullYear() >= 2000 && ['SynLoveSkillReview', 'SynLoveNewsDigest'].includes(task.id)) {
        activities.push({ id: `task-${task.id}`, at: at.toISOString(), text: `${names[task.id]} · 计划任务运行记录${task.result === 0 ? '（返回码 0）' : task.state === 'Running' ? '（正在执行）' : '（返回非零状态，请查看日志）'}`, kind: 'system' })
      }
    }
    return {
      at: new Date().toISOString(), activities: activities.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12), channels,
      backendFeatures: [music],
      schedules: [...reminders.rows, ...tasks.filter(row => !['SynLoveGuard', 'SynLoveConsoleWatch'].includes(row.id))],
      systemTasks: tasks.filter(row => ['SynLoveGuard', 'SynLoveConsoleWatch'].includes(row.id)),
      reminderTotal: reminders.total, errors: [reminders.error, system.error].filter(Boolean),
    }
  }
}
