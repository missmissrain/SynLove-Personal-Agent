/**
 * 实际Electron渲染验收：在隔离本地静态站点装载生产人物模块，保存画面和运行参数。
 * 参数argv为仓库路径、输出目录和可选页面地址；不启动业务后端，不发送聊天消息。
 */
const { app, BrowserWindow } = require('electron')
const { createServer, request } = require('node:http')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

class GuiRenderCheck {
  /** 参数root为仓库目录，out为输出目录；记录浏览器错误与模型帧数。 */
  constructor(root, out) {
    this.root = root
    this.out = out
    this.errors = []
    mkdirSync(out, { recursive: true })
  }

  /** 无传入参数；启动隔离页面或指定地址，核查真实WebGL输出并保存两帧。 */
  async run_check() {
    this.server = createServer((req, res) => {
      if (process.argv[5] === 'layout' && req.url.startsWith('/api/')) {
        if (req.method !== 'GET') { res.writeHead(405); return res.end() }
        const proxy = request(`http://127.0.0.1:19382${req.url}`, { timeout: 20000 }, upstream => {
          res.writeHead(upstream.statusCode, upstream.headers)
          upstream.pipe(res)
        })
        proxy.on('error', () => { res.writeHead(502); res.end('{}') })
        proxy.on('timeout', () => proxy.destroy())
        proxy.end()
        return
      }
      if (req.url === '/' && process.argv[5] === 'layout') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        return res.end(readFileSync(join(this.root, 'console/public/index.html')))
      }
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        return res.end(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"></head><body style="margin:0;background:#fcf6fa"><div id="tab-overview" class="active" style="width:1400px;height:900px"><div>日常一览</div></div>
          <link rel="stylesheet" href="/Avatar/AvatarPanel.css">
          <script type="module" src="/Avatar/AvatarPanel.js"></script></body></html>`)
      }
      try {
        const path = resolve(this.root, 'console/public', decodeURIComponent(req.url.split('?')[0].slice(1)))
        if (!path.startsWith(resolve(this.root, 'console/public'))) throw Error('outside public')
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.png') ? 'image/png' : 'application/octet-stream')
        res.end(readFileSync(path))
      } catch { res.writeHead(404); res.end() }
    })
    await new Promise(done => this.server.listen(0, '127.0.0.1', done))
    this.win = new BrowserWindow({ show: false, width: 1440, height: 1000,
      webPreferences: { backgroundThrottling: false, contextIsolation: true } })
    this.win.webContents.on('console-message', (_, level, message) => {
      if (level >= 2) this.errors.push(message.slice(0, 700))
    })
    await this.win.loadURL(process.argv[4] && process.argv[4] !== 'local'
      ? process.argv[4] : `http://127.0.0.1:${this.server.address().port}/`)
    for (let i = 0; i < 80; i++) {
      const state = await this.win.webContents.executeJavaScript(`window.synloveAvatarPanel?.card?.dataset.ready`)
      if (state === 'true') break
      if (state === 'error') throw Error(await this.win.webContents.executeJavaScript(`window.synloveAvatarPanel.status.textContent`))
      await new Promise(done => setTimeout(done, 250))
    }
    for (let i = 0; i < 60; i++) {
      if ((await this.read_state()).frames >= 10) break
      await new Promise(done => setTimeout(done, 200))
    }
    const before = await this.read_state()
    writeFileSync(join(this.out, '欣爱GUI实渲染.png'), (await this.win.webContents.capturePage()).toPNG())
    await new Promise(done => setTimeout(done, 2300))
    const after = await this.read_state()
    writeFileSync(join(this.out, '欣爱GUI待机第二帧.png'), (await this.win.webContents.capturePage()).toPNG())
    const report = { before, after, errors: this.errors, animated: after.frames > before.frames }
    if (process.argv[5] === 'motion') report.gestures = await this.capture_gestures()
    if (process.argv[5] === 'layout' || process.argv[5] === 'remoteLayout')
      report.layout = await this.check_layout()
    writeFileSync(join(this.out, 'GUI渲染验收.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    this.win.destroy()
    this.server.close()
    app.exit(report.animated && before.ready === 'true' ? 0 : 1)
  }

  /** 无传入参数；读取真实人物就绪状态、帧数、绘制数量和当前姿态。 */
  read_state() {
    return this.win.webContents.executeJavaScript(`(() => {
      const p=window.synloveAvatarPanel, a=p?.avatar;
      return {ready:p?.card?.dataset.ready,info:p?.info,frames:a?.frames,
        pose:a?.pose,canvas:a?.app?.view?.getBoundingClientRect().toJSON()};
    })()`)
  }

  /** 无传入参数；逐个驱动实际MOC3并从WebGL画布直接读取动作峰值图像。 */
  async capture_gestures() {
    const rows = []
    const names = ['curiousTilt','gentleNod','lookAside','lookBack','softSway','littleWave','relaxHands','listening']
    for (const name of names) {
      const result = await this.win.webContents.executeJavaScript(`(() => {
        const a=window.synloveAvatarPanel.avatar;
        a.paused=true;
        const preset=a.motion.gestures.presets.find(x=>x.name==='${name}');
        a.motion.time=preset.duration*.44;
        a.motion.gestures.start_action(0,'${name}');
        a.pose=a.motion.sample_pose(.001);
        a.model.update(1000/30);
        a.app.renderer.render(a.app.stage);
        return {image:a.app.view.toDataURL('image/png'),pose:a.pose,removedTitle:!document.querySelector('.companion-eyebrow')};
      })()`)
      writeFileSync(join(this.out, `待机动作-${name}.png`),Buffer.from(result.image.split(',')[1],'base64'))
      rows.push({name,pose:result.pose,removedTitle:result.removedTitle})
    }
    return rows
  }

  /** 无传入参数；实点三个页签，改变窗口大小并检查可见面板和横向溢出。 */
  async check_layout() {
    const rows = []
    for (const [width, height] of [[1440,1000], [1920,1080], [1366,768], [820,900], [480,900]]) {
      this.win.setSize(width,height)
      await new Promise(done => setTimeout(done, 500))
      for (const id of ['today','services','activity']) {
        const state = await this.win.webContents.executeJavaScript(`(() => {
          document.querySelector('[data-home-view="${id}"]').click();
          const host=document.querySelector('.companion-information');
          const panels=[...host.querySelectorAll('.companion-focus-panel')].filter(x=>getComputedStyle(x).display!=='none');
          return {view:host.dataset.homeView,visible:panels.map(x=>x.id),
            overflow:document.documentElement.scrollWidth>window.innerWidth+1,
            panelWidth:panels[0]?.getBoundingClientRect().width};
        })()`)
        rows.push({width,height,...state})
        if (state.visible.length !== 1 || state.overflow) throw Error(`layout failed ${JSON.stringify(rows.at(-1))}`)
        await new Promise(done => setTimeout(done, 250))
        if (id !== 'activity' && width >= 1366)
          writeFileSync(join(this.out, `主页-${width}-${id}.png`), (await this.win.webContents.capturePage()).toPNG())
      }
    }
    const keyboard = await this.win.webContents.executeJavaScript(`(() => {
      const start=document.querySelector('[data-home-view="today"]');
      start.click(); start.focus();
      start.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      const result={view:document.querySelector('.companion-information').dataset.homeView,focused:document.activeElement.dataset.homeView};
      document.querySelector('[data-home-view="today"]').click();
      return result;
    })()`)
    if (keyboard.view !== 'services' || keyboard.focused !== 'services') throw Error('keyboard navigation failed')
    rows.push({keyboard})
    return rows
  }

  /** 参数error为验收异常；保存实际错误与页面截图以便定位。 */
  async record_failure(error) {
    writeFileSync(join(this.out, 'GUI渲染失败.json'), JSON.stringify({error:String(error),errors:this.errors},null,2))
    if (this.win) writeFileSync(join(this.out, 'GUI失败画面.png'), (await this.win.webContents.capturePage()).toPNG())
  }
}
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
let check
app.whenReady().then(() => {
  check = new GuiRenderCheck(process.argv[2], process.argv[3])
  return check.run_check()
}).catch(async error => { await check?.record_failure(error); console.error(error); app.exit(1) })
