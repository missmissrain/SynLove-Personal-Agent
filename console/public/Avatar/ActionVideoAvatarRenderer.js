/**
 * 欣爱动作卡片播放器：读取服务器注册的23个完整动作视频，在动作期间覆盖Live2D画布。
 * 注册参数host为人物舞台、onEnd为动作结束回调；视频自带渐隐，不重复拼接旧动作。
 */
export class ActionVideoAvatarRenderer {
  /** 参数host为人物舞台；创建受控video元素并保持默认隐藏。 */
  constructor(host) {
    this.host = host
    this.video = document.createElement('video')
    this.video.className = 'companion-action-video'
    this.video.muted = true
    this.video.playsInline = true
    this.video.preload = 'metadata'
    this.video.hidden = true
    this.host.append(this.video)
    this.video.addEventListener('ended', () => this.finish())
    this.current = ''
    this.onEnd = null
  }

  /** 参数manifest为动作清单；加载服务器静态资源并返回动作数量。 */
  async load_manifest(manifest = '/Avatar/config/ActionManifest.json') {
    const response = await fetch(manifest, { cache: 'no-store' })
    if (!response.ok) throw new Error('动作清单读取失败')
    this.manifest = await response.json()
    this.index = new Map(this.manifest.actions.map(action => [action.name, action]))
    return this.manifest.actions.length
  }

  /** 参数name为注册动作名、loop为是否循环；显示完整动作卡并从头播放。 */
  async play_action(name, loop = false) {
    const action = this.index?.get(name)
    if (!action) return false
    this.current = name
    this.video.loop = loop
    this.video.src = `/Avatar/actions/${encodeURIComponent(action.file)}`
    this.video.hidden = false
    try {
      await this.video.play()
      return true
    } catch {
      this.video.hidden = true
      return false
    }
  }

  /** 无参数；动作结束后隐藏视频，恢复底层Live2D。 */
  finish() {
    this.video.pause()
    this.video.hidden = true
    const name = this.current
    this.current = ''
    this.onEnd?.(name)
  }

  /** 无参数；释放视频资源并移除元素。 */
  dispose() {
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    this.video.remove()
  }
}
