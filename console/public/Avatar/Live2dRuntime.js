/**
 * Live2D本地运行库加载器：依次装载固定版本Pixi、Cubism Core与Cubism适配层。
 * 注册参数无；默认仅访问同源资源，失败清除缓存以允许重试，不依赖运行时CDN。
 */
export class Live2dRuntime {
  /** 无传入参数；顺序加载本地依赖并返回PIXI命名空间。 */
  static async load_runtime() {
    if (!this.pending) this.pending = (async () => {
      for (const file of ['pixi.min.js', 'unsafe-eval.min.js', 'live2dcubismcore.min.js', 'cubism4.min.js']) {
        await this.load_script(`/Avatar/vendor/Live2d/${file}`)
      }
      if (!window.PIXI?.live2d?.Live2DModel) throw new Error('Live2D运行库初始化失败')
      return window.PIXI
    })().catch(error => { this.pending = null; throw error })
    return this.pending
  }

  /** 参数src为本地脚本路径；装载失败或超过二十秒时返回具体错误。 */
  static load_script(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      const timer = setTimeout(() => finish(new Error(`运行库载入超时：${src}`)), 20000)
      const finish = error => {
        clearTimeout(timer)
        script.onload = script.onerror = null
        if (error) { script.remove(); reject(error) } else resolve()
      }
      script.src = src
      script.onload = () => finish()
      script.onerror = () => finish(new Error(`运行库载入失败：${src}`))
      document.head.append(script)
    })
  }
}
