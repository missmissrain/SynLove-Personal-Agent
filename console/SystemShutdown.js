/**
 * 桌面完整退出：先持久暂停守护，再等待统一停栈入口验证端口释放。
 * 参数 root 为链路根目录，log 为日志函数；Python 优先环境变量及 console.env，默认 python。
 */
const { readFileSync, mkdirSync, writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawn } = require('node:child_process')

class SystemShutdown {
  /** root 为链路目录，log 接收脱敏状态；不在构造时改变运行状态。 */
  constructor(root, log) { this.root = root; this.log = log; this.running = null }

  /**
   * 参数 python：解释器路径；把 pythonw.exe 换成 python.exe。
   * 停栈脚本会拉 PowerShell/taskkill，pythonw 没有控制台会让它们各自弹出黑窗。
   */
  console_python(python) {
    if (process.platform === 'win32' && /pythonw\.exe$/i.test(python)) {
      const candidate = python.replace(/pythonw\.exe$/i, 'python.exe')
      if (existsSync(candidate)) return candidate
    }
    return python
  }

  /** 无参数；解析启动器记录的 Python 路径，不输出环境文件内容。 */
  resolve_python() {
    if (process.env.PYTHON && existsSync(process.env.PYTHON)) return process.env.PYTHON
    try {
      const text = readFileSync(join(this.root, 'config', 'console.env'), 'utf8')
      const match = text.match(/^\s*PYTHON\s*=\s*(.+)\s*$/m)
      const configured = match?.[1]?.trim().replace(/^["']|["']$/g, '')
      if (configured && existsSync(configured)) return configured
    } catch (error) { this.log('退出：使用默认 Python') }
    return process.platform === 'win32' ? 'python' : 'python3'
  }

  /** 无参数；幂等停栈，失败时保留暂停标记并拒绝报告退出成功。 */
  stop_system() {
    if (this.running) return this.running
    const cfgPath = process.env.SYNLOVE_SERVICE_CONFIG || join(this.root, 'config', 'serviceConfig.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')).services?.core ?? {}
    const external = (process.env.SYNLOVE_CORE_MANAGEMENT
      || (process.env.SYNLOVE_CORE_BASE_URL ? 'external' : cfg.management)) === 'external'
    const now = Date.now()
    const runtime = join(this.root, 'runtime')
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'guardian.pause'),
      JSON.stringify({ at: now, until: now + 10 * 365 * 86400000, reason: '用户选择完整退出 SynLove' }), 'utf8')
    this.running = new Promise((resolve, reject) => {
      const args = external
        ? [join(this.root, 'tools', 'CoreControl.py'), 'stop']
        : [join(this.root, 'tools', 'stop_stack.py'), '--pause-seconds', '315360000', '--with-business']
      const child = spawn(this.console_python(this.resolve_python()), args, {
          cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        })
      // 停栈脚本只输出进程及端口状态；有界保存尾部，方便定位失败原因。
      let output = ''
      const capture_output = chunk => { output = (output + chunk.toString('utf8')).slice(-4096) }
      child.stdout.on('data', capture_output)
      child.stderr.on('data', capture_output)
      const timer = setTimeout(() => { child.kill(); reject(new Error('停栈超时，已保留守护暂停')) }, 180000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => {
        clearTimeout(timer)
        if (output.trim()) this.log('停栈结果：', output.trim())
        if (code === 0) resolve()
        else reject(new Error(`停栈退出码 ${code}，请查看运行状态`))
      })
    }).finally(() => { this.running = null })
    return this.running
  }
}

module.exports = { SystemShutdown }
