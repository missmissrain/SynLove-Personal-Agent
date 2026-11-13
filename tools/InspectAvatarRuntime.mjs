/**
 * 生产人物只读验收：连接本机临时调试端口，检查真实桌面窗口的模型与待机帧数。
 * 参数 argv[2] 为输出目录，argv[3] 为回环调试端口，默认 19383；不调用业务写接口。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

class InspectAvatarRuntime {
  /** 参数 output 为检查产物目录，port 为已临时启用的回环调试端口。 */
  constructor(output, port = 19383) {
    this.output = output
    this.port = port
    this.sequence = 0
    this.pending = new Map()
    mkdirSync(output, { recursive: true })
  }

  /** 参数 method、params 为浏览器协议方法和参数，返回匹配请求的结果。 */
  call_method(method, params = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`浏览器检查超时：${method}`))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 无参数；只读提取生产主窗口的人物状态、模型版本、帧数及画布位置。 */
  async read_state() {
    const result = await this.call_method('Runtime.evaluate', {
      expression: `(() => {
        const p=window.synloveAvatarPanel,a=p?.avatar;
        const r=p?.card?.getBoundingClientRect();
        return {ready:p?.card?.dataset.ready,info:p?.info,frames:a?.frames,
          error:p?.status?.hidden?null:p?.status?.textContent,
          card:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};
      })()`,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error('生产窗口状态读取失败')
    return result.result.value
  }

  /** 无参数；检查待机推进并截取真实人物区域，输出可核对的 JSON 及 PNG。 */
  async run_check() {
    const targets = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json()
    const page = targets.find(item => item.type === 'page' &&
      /^http:\/\/127\.0\.0\.1:3082\/?$/.test(item.url))
    if (!page) throw new Error('没有找到生产控制台主窗口')
    this.socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', event => {
      const result = JSON.parse(event.data)
      const wait = this.pending.get(result.id)
      if (!wait) return
      clearTimeout(wait.timer)
      this.pending.delete(result.id)
      if (result.error) wait.reject(new Error(result.error.message))
      else wait.resolve(result.result)
    })
    try {
      let before
      for (let i = 0; i < 40; i++) {
        before = await this.read_state()
        if (before?.ready === 'true' || before?.ready === 'error') break
        await new Promise(done => setTimeout(done, 500))
      }
      await new Promise(done => setTimeout(done, 2200))
      const after = await this.read_state()
      const report = { before, after,
        passed: before?.ready === 'true' && after.frames > before.frames }
      if (after?.card?.width > 0 && after.card.height > 0) {
        const image = await this.call_method('Page.captureScreenshot', {
          format: 'png', clip: { ...after.card, scale: 1 }, captureBeyondViewport: false,
        })
        writeFileSync(join(this.output, '服务器人物实测.png'), Buffer.from(image.data, 'base64'))
      }
      writeFileSync(join(this.output, '生产人物验收.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify(report))
      if (!report.passed) throw new Error('生产人物未就绪或待机帧数未增长')
    } finally {
      this.socket.close()
    }
  }
}

await new InspectAvatarRuntime(process.argv[2], Number(process.argv[3] || 19383)).run_check()
