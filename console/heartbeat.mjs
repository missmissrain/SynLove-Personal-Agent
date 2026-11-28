/**
 * 后端守护心跳（控制台侧）。
 *
 * 负责：定时**真探活**后端（harness 3080 + 调试注入口 3081），连续失败到阈值就
 * **自动重启整条链路**，并把状态与最近决策暴露给 GUI；前端页面也会定时发心跳来触发一次检查。
 *
 * 设计要点（都是踩过坑之后定的）：
 * - 只认"真发 HTTP 请求"的结果：端口被别的进程占用时端口探测会显示在线，不可信；
 * - **连续失败够阈值**（默认 3 次）才动手，避免一两次网络抖动就把服务重启掉；
 * - 重启有**冷却**（默认 5 分钟）与**每小时上限**（默认 4 次），避免重启风暴；
 * - 重启后要**等到真的起来**（最多 180 秒）才算成功，否则记为失败并留下证据；
 * - 用户**手动停止**后端时自动暂停（否则守护会立刻把它拉回来，等于停不掉）；
 * - 每次状态变化/重启都写入 `runtime/heartbeat.log`（中文、带时间），GUI 可直接看。
 *
 * 快捷键（参数与默认值）：
 *   enabled=true           是否允许自动重启（关掉后只探活、不重启）
 *   interval_ms=30000      探活间隔
 *   fail_threshold=3       连续失败几次算掉线
 *   cooldown_ms=300000     两次自动重启之间的最小间隔
 *   max_restarts_per_hour=4 每小时自动重启上限
 *   wait_up_ms=180000      重启后最多等多久算"起来"
 *
 * @module console/heartbeat
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 默认参数。 */
const DEFAULTS = {
  enabled: true,
  interval_ms: 30_000,
  fail_threshold: 3,
  cooldown_ms: 300_000,
  max_restarts_per_hour: 4,
  wait_up_ms: 180_000,
}

/** 后端守护心跳：探活 + 自动重启。 */
export class Heartbeat {
  /**
   * @param {object} options 依赖注入（都传函数/路径，便于单独测试）
   *   project_dir     项目根目录（跑 start_stack.py 的 cwd）
   *   probes          探活目标 [{ port, name, url }]，全部通过才算后端在
   *   probe_http      探活函数 (url, timeout_ms) => Promise<{up, detail}>
   *   resolve_python  解析 python 路径的函数
   *   log_path        心跳日志路径
   *   config_path     参数持久化路径（json）
   *   pause_path      "暂停自动重启"标记文件（任何停止路径都能写它；跨控制台重启有效）
   *   now             取当前时间（便于测试注入）
   */
  constructor(options) {
    this.project_dir = options.project_dir
    this.probes = options.probes
    this.probe_http = options.probe_http
    this.resolve_python = options.resolve_python
    this.log_path = options.log_path
    this.config_path = options.config_path
    this.pause_path = options.pause_path ?? join(options.project_dir, 'runtime', 'guardian.pause')
    this.now = options.now ?? (() => Date.now())
    this.spawn = options.spawn ?? spawn

    this.config = { ...DEFAULTS, ...this.read_config() }
    this.state = {
      last_probe_at: 0,
      last_ok_at: 0,
      last_source: '',
      consecutive_fails: 0,
      detail: '尚未探活',
      probe_results: [],
      restarting: false,
      last_restart_at: 0,
      last_restart_result: '',
      restart_history: [],
      paused_reason: '',
      ticks: 0,
      page_pings: 0,
    }
    this.timer = null
    this.ticking = false
  }

  /** 读取持久化参数（缺失/损坏都退回默认值）。 */
  read_config() {
    try {
      if (!existsSync(this.config_path)) return {}
      return JSON.parse(readFileSync(this.config_path, 'utf8'))
    } catch {
      return {}
    }
  }

  /** 写回参数（GUI 改动立即生效）。 */
  save_config() {
    try {
      mkdirSync(dirname(this.config_path), { recursive: true })
      writeFileSync(this.config_path, JSON.stringify(this.config, null, 2), 'utf8')
    } catch { /* 写不进去不影响运行 */ }
  }

  /** 追加一行心跳日志（超 1MB 就截断，避免无限增长）。 */
  log(text) {
    const line = `[${new Date(this.now()).toLocaleString('sv-SE')}] ${text}\n`
    try {
      mkdirSync(dirname(this.log_path), { recursive: true })
      if (existsSync(this.log_path) && statSync(this.log_path).size > 1_048_576) {
        const kept = readFileSync(this.log_path, 'utf8').split('\n').slice(-300).join('\n')
        writeFileSync(this.log_path, kept, 'utf8')
      }
      appendFileSync(this.log_path, line, 'utf8')
    } catch { /* 日志失败不影响守护 */ }
    this.recent = [...(this.recent ?? []), line.trim()].slice(-40)
  }

  /** 启动定时探活（会先等一小会，让控制台自己先站稳）。 */
  start() {
    if (this.timer !== null) return
    this.log(`守护已启用：间隔 ${Math.round(this.config.interval_ms / 1000)}s、连续失败 ${this.config.fail_threshold} 次自动重启、冷却 ${Math.round(this.config.cooldown_ms / 60000)} 分钟`)
    setTimeout(() => { void this.tick('启动自检') }, 12_000).unref?.()
    this.timer = setInterval(() => { void this.tick('定时') }, this.config.interval_ms)
    this.timer.unref?.()
  }

  /** 停止定时探活。 */
  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 前端页面发来的心跳：记录一次，并按节流触发一次探活。
   * 页面关掉也没关系——上面的定时器是兜底。
   */
  note_page_ping() {
    this.state.page_pings += 1
    this.state.last_source = '前端心跳'
    const stale = this.now() - this.state.last_probe_at > Math.min(5_000, this.config.interval_ms / 2)
    if (stale && !this.ticking && !this.state.restarting) void this.tick('前端心跳')
    return this.snapshot()
  }

  /** 用户手动重启/停止后端时调用：期间不自动重启（避免和用户对着干）。 */
  pause(reason, ms = 30 * 60_000, options = {}) {
    this.state.paused_reason = reason
    this.pause_until = this.now() + ms
    this.state.consecutive_fails = 0
    if (options.persist === true) this.write_marker(reason, this.pause_until)
    this.log(`已暂停自动重启：${reason}（${Math.round(ms / 60000)} 分钟内不自动拉起${options.persist === true ? '，且写入持久标记' : ''}）`)
  }

  /** 恢复自动重启（GUI 上的按钮）：清掉内存暂停与持久标记。 */
  resume() {
    this.state.paused_reason = ''
    this.pause_until = 0
    this.clear_marker()
    this.log('已恢复自动重启')
  }

  /** 写"暂停"标记文件（供命令行/关机脚本等任何停止路径使用）。 */
  write_marker(reason, until) {
    try {
      mkdirSync(dirname(this.pause_path), { recursive: true })
      writeFileSync(this.pause_path, JSON.stringify({ reason, until, at: this.now() }, null, 2), 'utf8')
    } catch { /* 写不进去不影响内存里的暂停 */ }
  }

  /** 删标记文件。 */
  clear_marker() {
    try {
      if (existsSync(this.pause_path)) rmSync(this.pause_path)
    } catch { /* 忽略 */ }
  }

  /** 读"暂停"标记；过期就顺手删掉。 */
  read_marker() {
    try {
      if (!existsSync(this.pause_path)) return null
      const parsed = JSON.parse(readFileSync(this.pause_path, 'utf8'))
      if (typeof parsed?.until === 'number' && parsed.until <= this.now()) {
        this.clear_marker()
        return null
      }
      return parsed
    } catch {
      return { reason: '标记文件损坏', until: 0 }
    }
  }

  /** 是否处于"用户手动操作后的暂停期"（内存暂停或持久标记）。 */
  get paused() {
    if ((this.pause_until ?? 0) > this.now()) return true
    return this.read_marker() !== null
  }

  /** 暂停原因（给 GUI 显示）。 */
  get paused_reason() {
    if ((this.pause_until ?? 0) > this.now()) return this.state.paused_reason
    const marker = this.read_marker()
    return marker === null ? '' : `${marker.reason}（持久标记，重启控制台也有效）`
  }

  /**
   * 探活一次。
   * @param source 这一次探活的来源（定时 / 前端心跳 / 手动）
   */
  async tick(source = '定时') {
    if (this.ticking) return this.snapshot()
    this.ticking = true
    try {
      const results = []
      for (const target of this.probes) {
        const outcome = await this.probe_http(target.url, 2500)
        results.push({ port: target.port, name: target.name, ...outcome })
      }
      const down = results.filter(item => !item.up)
      this.state.ticks += 1
      this.state.last_probe_at = this.now()
      this.state.last_source = source
      this.state.probe_results = results
      const was_down = this.state.consecutive_fails >= this.config.fail_threshold

      if (down.length === 0) {
        if (was_down || this.state.consecutive_fails > 0) {
          this.log(`后端恢复在线（${results.map(item => `${item.port}:${item.detail}`).join(' ')}）`)
        }
        this.state.consecutive_fails = 0
        this.state.last_ok_at = this.now()
        this.state.detail = `在线（${results.map(item => `${item.port} ${item.detail}`).join('、')}）`
        return this.snapshot()
      }

      this.state.consecutive_fails += 1
      this.state.detail = `掉线：${down.map(item => `${item.port} ${item.detail}`).join('、')}（连续 ${this.state.consecutive_fails} 次）`
      this.log(`探活失败 ${this.state.consecutive_fails}/${this.config.fail_threshold}：${down.map(item => `${item.port} ${item.detail}`).join('、')}（来源 ${source}）`)
      return await this.maybe_restart(down)
    } finally {
      this.ticking = false
    }
  }

  /** 判断该不该自动重启，并在允许时执行。 */
  async maybe_restart(down) {
    if (!this.config.enabled) {
      this.state.detail += '｜自动重启已关闭'
      return this.snapshot()
    }
    if (this.paused) {
      this.state.detail += `｜已暂停（${this.paused_reason}）`
      return this.snapshot()
    }
    if (this.state.consecutive_fails < this.config.fail_threshold) return this.snapshot()
    if (this.state.restarting) {
      this.state.detail += '｜正在重启中'
      return this.snapshot()
    }
    if (this.now() - this.state.last_restart_at < this.config.cooldown_ms) {
      this.state.detail += '｜冷却中，暂不重启'
      return this.snapshot()
    }
    const hour_ago = this.now() - 3_600_000
    const recent = this.state.restart_history.filter(stamp => stamp >= hour_ago)
    if (recent.length >= this.config.max_restarts_per_hour) {
      this.state.detail += `｜本小时已重启 ${recent.length} 次，达上限`
      this.log(`放弃自动重启：本小时已重启 ${recent.length} 次（上限 ${this.config.max_restarts_per_hour}）`)
      return this.snapshot()
    }
    await this.restart(down)
    return this.snapshot()
  }

  /**
   * 自动重启整条链路：调 start_stack.py，然后**等它真的起来**。
   * 关键：启动进程带 PYTHONUTF8=1 —— 这台机器上 site-packages 里可能混进
   * 非 GBK 的 .pth（别的项目写的），会导致 python 直接启动失败。
   */
  async restart(down) {
    this.state.restarting = true
    this.state.last_restart_at = this.now()
    this.state.restart_history.push(this.now())
    this.state.restart_history = this.state.restart_history.filter(stamp => stamp >= this.now() - 86_400_000)
    const reason = down.map(item => `${item.port} ${item.detail}`).join('、')
    this.log(`开始自动重启（原因：${reason}）`)

    try {
      const child = this.spawn(this.resolve_python(), ['start_stack.py'], {
        cwd: this.project_dir,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      child.unref?.()
    } catch (error) {
      this.state.restarting = false
      this.state.last_restart_result = `启动失败：${error instanceof Error ? error.message : String(error)}`
      this.log(`自动重启失败：${this.state.last_restart_result}`)
      return
    }

    const deadline = this.now() + this.config.wait_up_ms
    let up = false
    while (this.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5_000))
      let alive = true
      for (const target of this.probes) {
        const outcome = await this.probe_http(target.url, 2500)
        if (!outcome.up) alive = false
      }
      if (alive) { up = true; break }
    }
    this.state.restarting = false
    if (up) {
      this.state.consecutive_fails = 0
      this.state.last_ok_at = this.now()
      this.state.last_restart_result = '重启成功（服务已就绪）'
      this.state.detail = '在线（自动重启后恢复）'
      this.log('自动重启成功：后端已恢复在线')
    } else {
      this.state.last_restart_result = `重启后 ${Math.round(this.config.wait_up_ms / 1000)} 秒内仍未就绪，请查看 runtime/harness-run.log`
      this.log(`自动重启后仍未就绪：${this.state.last_restart_result}`)
    }
  }

  /** 修改参数（GUI 用）。 */
  set_config(patch = {}) {
    const numeric = {
      interval_ms: [5_000, 3_600_000],
      fail_threshold: [1, 20],
      cooldown_ms: [10_000, 86_400_000],
      max_restarts_per_hour: [1, 100],
    }
    if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled
    for (const [key, [low, high]] of Object.entries(numeric)) {
      const value = Number(patch[key])
      if (Number.isFinite(value)) this.config[key] = Math.min(high, Math.max(low, Math.round(value)))
    }
    this.save_config()
    this.log(`参数已更新：${JSON.stringify({ enabled: this.config.enabled, interval_ms: this.config.interval_ms, fail_threshold: this.config.fail_threshold, cooldown_ms: this.config.cooldown_ms, max_restarts_per_hour: this.config.max_restarts_per_hour })}`)
    if (this.timer !== null) { this.stop(); this.start() }
    return this.snapshot()
  }

  /** 给 GUI 的状态快照。 */
  snapshot() {
    return {
      config: this.config,
      ...this.state,
      paused: this.paused,
      paused_reason: this.paused_reason,
      pause_path: this.pause_path,
      recent: this.recent ?? [],
      probes: this.probes.map(item => ({ port: item.port, name: item.name })),
    }
  }
}
