/**
 * 视频开屏模块：接到调度后播放本地 MP4，结束后淡出，后台界面同时加载。
 * 注册参数 root：开屏容器；source：轮换视频路径，默认第一段；淡出 900ms、卡顿容忍 8 秒。
 * 是否重播由独立调度和主进程决定，本类只管理一次播放的生命周期。
 */
class OpeningScreen {
  /** 参数 root/source：视频容器和同源视频路径；限定本地资源并绑定媒体事件与失效兜底。 */
  constructor(root, source = '/assets/Opening.mp4') {
    this.root = root
    this.source = ['/assets/Opening.mp4', '/assets/Opening2.mp4', '/assets/Opening3.mp4'].includes(source)
      ? source : '/assets/Opening.mp4'
    this.video = root.querySelector('video')
    this.video.volume = 1
    this.video.muted = false
    this.events = new AbortController()
    const options = { signal: this.events.signal }
    this.state = 'waiting'
    this.timer = null
    this.finishTimer = null
    this.volumeFrame = null
    this.locked = []
    this.on_visibility = () => {
      if (!document.hidden && this.state === 'waiting') this.start_video()
    }
    this.on_escape = event => {
      if (event.key === 'Escape') { event.preventDefault(); this.fade_out() }
    }
    this.video.addEventListener('ended', () => this.fade_out(), options)
    this.video.addEventListener('error', () => this.fade_out(), options)
    this.video.addEventListener('playing', () => this.mark_playing(), options)
    this.video.addEventListener('waiting', () => this.arm_timeout(), options)
    this.video.addEventListener('stalled', () => this.arm_timeout(), options)
    root.querySelector('button').addEventListener('click', () => this.fade_out(), options)
    root.addEventListener('transitionend', event => {
      if (event.target === root && event.propertyName === 'opacity' && this.state === 'fading') this.finish_opening()
    }, options)
    root.hidden = false
    root.dataset.state = this.state
    for (const node of document.querySelectorAll('#desktop-titlebar, header, #tabs, main')) {
      this.locked.push({ node, inert: node.inert })
      node.inert = true
    }
    document.addEventListener('visibilitychange', this.on_visibility)
    document.addEventListener('keydown', this.on_escape, true)
    this.on_visibility()
  }

  /** 无参数；设置媒体来源并开始播放，音频自动播放受限时回退到静音，失败则淡出。 */
  async start_video() {
    if (this.state !== 'waiting') return
    this.state = 'loading'
    this.root.dataset.state = this.state
    this.video.src = this.source
    this.arm_timeout()
    try {
      await this.video.play()
    } catch (error) {
      if (this.state === 'fading' || this.state === 'done') return
      if (error.name === 'NotAllowedError') {
        this.video.muted = true
        try { await this.video.play() } catch { this.fade_out() }
      } else this.fade_out()
    }
  }

  /** 无参数；播放恢复后解除卡顿超时，并按剩余时长设置最终退出期限。 */
  mark_playing() {
    if (this.state === 'fading' || this.state === 'done') return
    this.state = 'playing'
    this.root.dataset.state = this.state
    const remaining = Math.max(0, this.video.duration - this.video.currentTime) * 1000
    this.arm_timeout(Number.isFinite(remaining) ? Math.min(60000, remaining + 8000) : 20000)
  }

  /** 参数 delay：等待毫秒数，默认 8000；超时后进入淡出，避免媒体异常遮住界面。 */
  arm_timeout(delay = 8000) {
    if (this.state === 'fading' || this.state === 'done') return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.fade_out(), delay)
  }

  /** 无参数；保留末帧并平滑降低画面与声音，等待透明度过渡结束后再移除遮罩。 */
  fade_out() {
    if (this.state === 'fading' || this.state === 'done') return
    this.state = 'fading'
    clearTimeout(this.timer)
    this.root.dataset.state = this.state
    const start = performance.now()
    const volume = this.video.volume
    const fade_audio = now => {
      // 同帧回调时间可能早于调用时刻，进度需同时限制下界，避免音量超过 1。
      const progress = Math.max(0, Math.min(1, (now - start) / 900))
      this.video.volume = Math.max(0, volume * (1 - progress))
      if (progress < 1) this.volumeFrame = requestAnimationFrame(fade_audio)
    }
    this.volumeFrame = requestAnimationFrame(fade_audio)
    this.finishTimer = setTimeout(() => this.finish_opening(), 1200)
  }

  /** 无参数；释放媒体资源与输入锁，标记当前窗口已经播放，并清理计时器和事件。 */
  finish_opening() {
    if (this.state === 'done') return
    this.state = 'done'
    this.events.abort()
    this.root.dataset.state = this.state
    this.root.hidden = true
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    clearTimeout(this.timer)
    clearTimeout(this.finishTimer)
    cancelAnimationFrame(this.volumeFrame)
    for (const { node, inert } of this.locked) node.inert = inert
    document.removeEventListener('visibilitychange', this.on_visibility)
    document.removeEventListener('keydown', this.on_escape, true)
  }
}
