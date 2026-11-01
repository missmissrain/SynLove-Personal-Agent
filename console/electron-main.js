/**
 * SynLove · Electron 桌面壳。
 *
 * 行为约定（按用户要求）：
 * - **右上角的叉叉 = 最小化到任务栏**（托盘），不退出程序；
 * - **右击托盘图标 → 菜单里有"退出"**，那才是真正关闭；
 * - 左击托盘图标 → 重新显示窗口。
 *
 * 本地服务（server.mjs）由本进程按需拉起：它只用 Node 内置模块，
 * 所以桌面壳里不需要任何额外依赖，也不会和外部服务抢端口。
 */

const electron = require('electron')
const { app, Menu, Tray, nativeImage, shell, dialog } = electron
const { ConsoleStartup } = require('./ConsoleStartup.js')
const { spawn, spawnSync } = require('node:child_process')
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { DesktopIdentity } = require('./DesktopIdentity.js')
const { DesktopWindow } = require('./DesktopWindow.js')
const { SystemShutdown } = require('./SystemShutdown.js')

/** 把启动与异常写进 console/electron.log，方便事后排查（GUI 的报错在终端里看不到）。 */
const LOG = join(__dirname, 'electron.log')
function log(...parts) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`, 'utf8')
  } catch { /* 日志写不进去也不该影响启动 */ }
}
process.on('uncaughtException', error => log('uncaughtException:', error?.stack ?? String(error)))
process.on('unhandledRejection', reason => log('unhandledRejection:', String(reason)))

const PORT = Number(process.env.CONSOLE_PORT ?? 3082)
const URL = `http://127.0.0.1:${PORT}`
const startup = new ConsoleStartup({ url: URL, log })
const HERE = __dirname
const identity = new DesktopIdentity({ app, shell, root: HERE, log })
const shutdown = new SystemShutdown(join(HERE, '..'), log)
/**
 * 开机自启用 `--hidden` 启动：只驻留托盘，不弹窗口。
 * 手动双击 start-console-gui.cmd 时不带这个参数，会正常显示窗口。
 */
const START_HIDDEN = process.argv.includes('--hidden')

/** 应用是否正在退出（用它区分"叉叉"与"真退出"）。 */
let quitting = false
let mainWindow = null
let tray = null
let serverProcess = null

// 用户提供的原创图标同时用于窗口和托盘；运行时只读取导出的轻量 PNG。
const icon = nativeImage.createFromPath(join(HERE, 'public', 'assets', 'BrandIcon.png'))
if (icon.isEmpty()) log('品牌图标加载失败：public/assets/BrandIcon.png')
const desktop = new DesktopWindow({ electron, url: URL, preload: join(HERE, 'DesktopPreload.js'), icon })

// ── 本地服务 ───────────────────────────────────────────────────────────────

/** 端口是否已经在监听（已经手动起过服务时就不重复拉）。 */
async function server_alive() {
  return new Promise(resolve => {
    const net = require('node:net')
    const socket = new net.Socket()
    socket.setTimeout(600)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.connect(PORT, '127.0.0.1')
  })
}

/**
 * 找一个**真正的 Node** 来跑本地服务。
 *
 * 为什么不能用 Electron 自己（`process.execPath` + `ELECTRON_RUN_AS_NODE`）：
 * 本地服务用了 `node:sqlite`（Node 22.5 才有），而 Electron 33 内置的是 Node 20
 * —— 拿它当 Node 跑，`import 'node:sqlite'` 直接抛错、服务秒退、端口永远起不来。
 * 这正是"开机自启报『控制台服务启动失败』"的根因（而手动用真 node 起过服务时，
 * 它只是检测到端口已占用就显示成功，所以看起来时好时坏）。
 *
 * 顺序：环境变量 → 启动器写在 console.env 里的 NODE= → PATH 里的 node。
 */
function resolve_node() {
  const from_env = process.env.CONSOLE_NODE
  if (from_env && existsSync(from_env)) return from_env
  try {
    const env_file = join(HERE, '..', 'config', 'console.env')
    if (existsSync(env_file)) {
      for (const line of readFileSync(env_file, 'utf8').split('\n')) {
        const match = /^\s*CONSOLE_NODE\s*=\s*(.+?)\s*$/.exec(line)
        if (match && existsSync(match[1])) return match[1]
      }
    }
  } catch { /* 读不到就继续往下找 */ }
  try {
    const found = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
    const first = String(found.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean)[0]
    if (first && existsSync(first)) return first
  } catch { /* 忽略 */ }
  return undefined
}

/** 确保本地服务在跑；返回 `{ok, detail}`（detail 带原因，便于报错时直接给用户看）。 */
async function ensure_server() {
  if (await server_alive()) return { ok: true, detail: '端口已在监听（复用已有服务）' }
  const server = join(HERE, 'server.mjs')
  if (!existsSync(server)) return { ok: false, detail: `找不到服务脚本：${server}` }

  const node = resolve_node()
  // 找不到真 node 时退回 Electron 自带 Node（可能在 node:sqlite 处失败，但至少留下原因）
  const command = node ?? process.execPath
  const env = node === undefined ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env }
  log('starting server with', node === undefined ? 'electron-as-node（未找到真 node）' : node)

  // 启动前先做一次语法检查：脚本有语法错时**绝对不要弹模态框**——
  // 模态框会一直等用户点"确定"，而外部看护每 5 分钟又拉起一个新实例，
  // 用户看到的就是"GUI 总是崩溃、反复弹同一个错误"。这里只把原因写进
  // electron.log + runtime/console-startup-error.log，然后正常退出，让看护/用户排查。
  try {
    const check = spawnSync(command, ['--check', server], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    if (check.status !== 0) {
      const detail = String(check.stderr || check.stdout || check.error || '语法检查未通过').slice(0, 1500)
      return { ok: false, detail: `server.mjs 语法检查失败：${detail}` }
    }
  } catch (error) {
    log('server 语法检查异常：', String(error))
  }

  let stderr = ''
  serverProcess = spawn(command, [server, String(PORT)], {
    cwd: HERE,
    windowsHide: true,
    // **必须捕获**：以前用 stdio:'ignore'，子进程的错误被丢掉，
    // 日志里只剩“server ready = false”，根本查不出为什么（这次就吃了这个亏）。
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  const collect = chunk => {
    stderr = (stderr + String(chunk)).slice(-4000)
  }
  serverProcess.stdout?.on('data', collect)
  serverProcess.stderr?.on('data', collect)
  serverProcess.on('error', error => { stderr = `${stderr}\nspawn 失败：${error.message}` })
  serverProcess.unref()

  for (let i = 0; i < 60; i += 1) {          // 最多等 18 秒（机器忙时也别急着报错）
    await new Promise(resolve => setTimeout(resolve, 300))
    if (await server_alive()) return { ok: true, detail: `已启动（${command}）` }
    if (serverProcess.exitCode !== null) break   // 进程已退出，不用再等
  }
  if (stderr.trim() !== '') log('server stderr:', stderr.trim().slice(0, 1500))
  return { ok: false, detail: stderr.trim() === '' ? '服务没有在端口上监听起来' : stderr.trim() }
}

// ── 窗口 ───────────────────────────────────────────────────────────────────

function create_window() {
  mainWindow = desktop.create_window()
  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) show_window()
  })
  identity.apply_window(mainWindow)
  mainWindow.loadURL(URL)

  // 外链走系统浏览器，别在壳里打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === new URL(URL).href) return
    event.preventDefault()
    if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url)
  })

  // 关键：叉叉 = 最小化到托盘，不退出
  mainWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
    if (tray) tray.displayBalloon?.({
      title: identity.name,
      content: '已最小化到托盘；右击托盘图标可以退出。',
      icon,
    })
  })
  mainWindow.on('closed', () => { mainWindow = null })
  // 页面/渲染进程出问题要留痕（否则窗口白屏也查不到原因）
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) =>
    log('did-fail-load', code, description, url))
  mainWindow.webContents.on('render-process-gone', (_event, details) =>
    log('render-process-gone', JSON.stringify(details)))
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) log('renderer console:', message)
  })
  // 关闭 = 隐藏到托盘（见上面 close 处理）；这里只记录，便于确认行为生效
  mainWindow.on('hide', () => log('window hidden (minimized to tray)'))
}

/** 显示窗口（没有就重建）。 */
function show_window() {
  if (mainWindow === null) create_window()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

// ── 托盘 ───────────────────────────────────────────────────────────────────

function create_tray() {
  tray = new Tray(icon)
  tray.setToolTip(identity.name)
  // 右击托盘图标 → 这个菜单（里面有"退出"）
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 SynLove', click: show_window },
    { type: 'separator' },
    {
      label: '重启后端服务（harness）',
      click: async () => {
        const ok = await ensure_server()
        if (!ok) return
        try {
          await fetch(`${URL}/api/service`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'restart' }),
          })
        } catch { /* 服务没起来就算了，用户可以在界面里重试 */ }
        show_window()
      },
    },
    { type: 'separator' },
    {
      label: '退出界面（后台继续运行）',
      click: () => { quitting = true; app.quit() },
    },
    {
      label: '停止系统并退出',
      click: async (item) => {
        if (shutdown.running) return
        item.enabled = false
        item.label = '正在停止系统…'
        tray?.setToolTip('SynLove 正在停止系统')
        try {
          await shutdown.stop_system()
          quitting = true
          if (serverProcess) serverProcess.kill()
          app.quit()
        } catch (error) {
          log('完整退出失败：', String(error))
          item.enabled = true
          item.label = '停止系统并退出'
          tray?.setToolTip('SynLove 停止未完成，守护已暂停')
          dialog.showErrorBox('SynLove 停止未完成', `${String(error)}\n后台守护已暂停。请查看 console/electron.log 中的停栈结果。`)
        }
      },
    },
  ]))
  // 左击：显示窗口
  tray.on('click', show_window)
}

// ── 前端自愈（控制台服务守护） ──────────────────────────────────────────────

let superviseTimer = null
let superviseFails = 0
let superviseRestarts = []

/**
 * 探一下控制台服务是否**真的能响应**（不是"端口在监听"）。
 * 用 /api/heartbeat 探：它既是健康检查，也顺带证明后端守护那一套在跑。
 */
async function console_api_alive() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/heartbeat`, {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 前端自愈：服务进程意外退出/卡死 → 自动重拉。
 *
 * 为什么放在 Electron 这边：后端守护住在**控制台服务进程**里，服务一死守护就没了，
 * 于是"后端掉线能自动复活"这条链也会一起失效。这里让外壳（Electron 托盘常驻）
 * 负责把服务拉回来 —— 窗口最小化到托盘、甚至窗口关掉都照样生效。
 * 带退避与次数上限：10 分钟内最多 6 次，超过就只记日志不再折腾。
 */
async function supervise_console() {
  if (quitting) return
  if (await console_api_alive()) {
    superviseFails = 0
    return
  }
  superviseFails += 1
  if (superviseFails < 2) return            // 连续两次无响应才动手，避免偶发抖动
  const now = Date.now()
  superviseRestarts = superviseRestarts.filter(stamp => now - stamp < 600_000)
  if (superviseRestarts.length >= 6) {
    if (superviseRestarts.length === 6) log('控制台服务反复无响应，已暂停自愈（10 分钟窗口内 6 次）')
    superviseRestarts.push(now)
    return
  }
  superviseRestarts.push(now)
  superviseFails = 0
  log('控制台服务无响应，正在自动重启（第', superviseRestarts.length, '次）')
  try {
    if (serverProcess && serverProcess.exitCode === null) {
      try { serverProcess.kill() } catch { /* 已经退出了 */ }   // 卡死的旧进程先清掉，免得占着端口
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    const result = await ensure_server()
    log('控制台服务自愈结果 =', result.ok, '|', String(result.detail).slice(0, 200))
  } catch (error) {
    log('控制台服务自愈异常：', String(error))
  }
}

/** 启动前端自愈定时器（每 20 秒探一次）。 */
function start_supervise_console() {
  if (superviseTimer !== null) return
  superviseTimer = setInterval(() => { void supervise_console() }, 20_000)
  log('控制台自愈已启用（每 20 秒探活 /api/heartbeat）')
}

// ── 生命周期 ───────────────────────────────────────────────────────────────

// 只允许一个实例：重复启动时把已有窗口叫出来
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    show_window()
    void startup.request_start()
  })

  app.whenReady().then(async () => {
    identity.register_shortcut()
    log('app ready; electron', process.versions.electron, 'port', PORT)
    create_tray()
    const result = await ensure_server()
    log('server ready =', result.ok, '|', result.detail.slice(0, 200))
    if (!result.ok) {
      // 不弹模态框：模态框会一直等"确定"，而外部看护每 5 分钟又拉起新实例，
      // 用户看到的就是"GUI 总是崩溃、反复弹同一个错误"。只写日志 + 托盘提示后退出。
      const reason = String(result.detail || '未知原因')
      log('控制台启动失败：', reason.slice(0, 1200))
      try {
        writeFileSync(join(HERE, '..', 'runtime', 'console-startup-error.log'),
          `${new Date().toISOString()}\n${reason}\n`, 'utf8')
      } catch { /* 写不进去也不影响退出 */ }
      try { tray?.setToolTip('SynLove 启动失败，详情见 runtime/console-startup-error.log') } catch { /* 托盘可能还没建好 */ }
      quitting = true
      app.quit()
      return
    }
    create_window()
    start_supervise_console()
    void startup.request_start()
    if (START_HIDDEN) {
      // 开机自启：静默驻留托盘（用户点托盘图标即可唤出）
      mainWindow.hide()
      log('started hidden (autostart)')
    }
  })

  app.on('window-all-closed', () => {
    // 有托盘，不随窗口关闭而退出（这正是"叉叉只是最小化"的效果）
  })

  app.on('before-quit', () => { quitting = true })
}
