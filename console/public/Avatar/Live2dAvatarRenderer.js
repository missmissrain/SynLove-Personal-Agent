/**
 * 欣爱Live2D展示器：装载已验收自然站姿MOC3，管理透明画布、响应式构图与低功耗待机。
 * 注册参数host为DOM容器；默认30帧、像素比最高1.5，隐藏页面暂停，不修改业务服务。
 */
import { Live2dRuntime } from './Live2dRuntime.js'
import { Live2dIdleMotion } from './Live2dIdleMotion.js'

export class Live2dAvatarRenderer {
  /** 参数host为人物画布宿主；注册尺寸、显隐与WebGL丢失事件。 */
  constructor(host) {
    this.host = host
    this.motion = new Live2dIdleMotion()
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)')
    this.paused = false
    this.disposed = false
    this.lastTime = 0
    this.frames = 0
    this.onLost = event => {
      event.preventDefault()
      this.paused = true
      host.dispatchEvent(new CustomEvent('avatar:error', { detail: '显卡上下文已中断，请刷新人物展示' }))
    }
    this.onRestored = () => location.reload()
    this.observer = new ResizeObserver(() => this.resize_view())
    this.observer.observe(host)
    this.onPageHide = () => this.dispose_view()
    window.addEventListener('pagehide', this.onPageHide, { once: true })
  }

  /** 无传入参数；载入本地运行库、纹理与模型，成功后返回真实模型信息。 */
  async load_model() {
    const PIXI = await Live2dRuntime.load_runtime()
    const response = await fetch('/Avatar/config/IdleGestures.json')
    if (!response.ok) throw new Error('待机动作配置读取失败')
    const config = await response.json()
    this.motion = new Live2dIdleMotion(Math.random, config.presets)
    if (this.disposed) throw new Error('人物展示已经关闭')
    this.app = new PIXI.Application({
      width: Math.max(1, this.host.clientWidth), height: Math.max(1, this.host.clientHeight),
      backgroundAlpha: 0, antialias: true, autoStart: false,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5), autoDensity: true,
    })
    this.host.append(this.app.view)
    this.app.view.addEventListener('webglcontextlost', this.onLost)
    this.app.view.addEventListener('webglcontextrestored', this.onRestored)
    try {
      this.model = await PIXI.live2d.Live2DModel.from('/Avatar/live2d/XinAi.model3.json', {
        autoUpdate: false, autoInteract: false, motionPreload: 'NONE',
        idleMotionGroup: '__manualIdle',
      })
      if (this.disposed) { this.model.destroy({ texture: true, baseTexture: true }); throw new Error('人物展示已经关闭') }
      this.model.internalModel.motionManager.stopAllMotions()
      this.model.internalModel.on('beforeModelUpdate', () => {
        for (const [id, value] of Object.entries(this.pose || {}))
          this.model.internalModel.coreModel.setParameterValueById(id, value)
      })
      this.app.stage.addChild(this.model)
      this.resize_view()
      this.tick = time => { this.render_frame(time); if (!this.disposed) this.frameId = requestAnimationFrame(this.tick) }
      this.frameId = requestAnimationFrame(this.tick)
      return { type: 'Live2D', model: 'XinAiLimbSeparated20261113', drawables: this.model.internalModel.coreModel.getDrawableCount() }
    } catch (error) { this.dispose_view(); throw error }
  }

  /** 无传入参数；截取模型上半身并居中，按窗口尺寸预留头顶与落款空间。 */
  resize_view() {
    if (!this.app || !this.model || this.disposed) return
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight)
    this.app.renderer.resize(w, h)
    const scale = Math.min(w / (this.model.internalModel.width * .64),
      Math.max(1, h - 130) / (this.model.internalModel.height * .52))
    this.model.scale.set(scale)
    this.model.position.set((w - this.model.width) / 2, 86 - this.model.height * .04)
  }

  /** 参数time为浏览器时间戳；控制30帧上限，隐藏或离屏时不推进动作。 */
  render_frame(time) {
    if (this.paused || document.hidden || !this.model) { this.lastTime = 0; return }
    if (this.lastTime && time - this.lastTime < 1000 / 30) return
    const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, .5) : 1 / 30
    this.lastTime = time
    this.pose = this.motion.sample_pose(dt, this.reduced.matches)
    this.model.update(Math.min(dt, .08) * 1000)
    this.app.renderer.render(this.app.stage)
    this.frames++
  }

  /** 参数values为左右闭眼量和张嘴量数组，null恢复待机；兼容原有预览接口。 */
  set_preview(values) { this.motion.preview = values }

  /** 无传入参数；彻底释放纹理、MOC、画布与监听，防止重复进入页面占用显存。 */
  dispose_view() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frameId)
    this.observer.disconnect()
    window.removeEventListener('pagehide', this.onPageHide)
    if (this.app) {
      this.app.view.removeEventListener('webglcontextlost', this.onLost)
      this.app.view.removeEventListener('webglcontextrestored', this.onRestored)
      this.app.destroy(true, { children: true, texture: true, baseTexture: true })
    }
  }
}
