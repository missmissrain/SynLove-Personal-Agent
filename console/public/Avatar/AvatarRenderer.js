/**
 * 人物三维渲染：载入本机认可模型的真实网格和嘴眼形态，管理显隐、上下文恢复及资源释放。
 * 参数host为展示容器，base为同源资产目录；默认30fps、像素比最高1.5、不使用远端CDN。
 */
import * as THREE from './vendor/Three.js'
import { AvatarMaterial } from './AvatarMaterial.js'
import { AvatarMotionController } from './AvatarMotionController.js'

export class AvatarRenderer {
  /** 参数host/base：显示容器及资源位置；新建独立WebGL场景，不接触智能体业务状态。 */
  constructor(host, base = '/Avatar/assets/') {
    this.host = host
    this.base = base
    this.controls = { value: new THREE.Vector3() }
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0, 0)
    this.renderer.debug.onShaderError = () => {
      host.dispatchEvent(new CustomEvent('avatar:error', { detail: '人物材质编译失败' }))
    }
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-.2, .2, .2, -.2, .01, 10)
    this.camera.position.set(0, .793, 1)
    this.camera.lookAt(0, .793, 0)
    this.figure = new THREE.Group()
    this.scene.add(this.figure)
    this.textures = new Map()
    this.host.append(this.renderer.domElement)
    this.paused = false
    this.disposed = false
    this.last = 0
    this.start = performance.now()
    this.nextBlink = this.start + 3500
    this.blinkStart = 0
    this.speakUntil = 0
    this.manual = null
    this.frameCount = 0
    this.resize = new ResizeObserver(() => this.resize_view())
    this.resize.observe(host)
    this.visibility = () => { if (document.hidden) this.last = 0 }
    document.addEventListener('visibilitychange', this.visibility)
    this.contextLost = event => {
      event.preventDefault()
      this.paused = true
      host.dispatchEvent(new CustomEvent('avatar:error', { detail: '图形上下文暂不可用' }))
    }
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost)
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.paused = document.hidden
      host.dispatchEvent(new CustomEvent('avatar:restored'))
    })
  }

  /** 无参数；校验同源清单和二进制边界，建立可独立控制的真实网格。 */
  async load_model() {
    const manifestResponse = await fetch(`${this.base}Avatar.json`)
    if (!manifestResponse.ok) throw new Error('人物清单读取失败')
    const manifest = await manifestResponse.json()
    if (manifest.format !== 'SynLoveAvatarRig2') throw new Error('人物格式不匹配')
    const binaryResponse = await fetch(`${this.base}Avatar.bin`)
    if (!binaryResponse.ok) throw new Error('人物网格读取失败')
    const buffer = await binaryResponse.arrayBuffer()
    if (buffer.byteLength !== manifest.bytes) throw new Error('人物网格不完整')
    this.motion = new AvatarMotionController(THREE,manifest.skeleton)
    const loader = new THREE.TextureLoader()
    for (const part of manifest.parts) {
      const info = part.material
      if (info.texture && !this.textures.has(info.texture)) {
        const texture = await loader.loadAsync(`${this.base}${info.texture}`)
        texture.colorSpace = THREE.SRGBColorSpace
        texture.flipY = true
        this.textures.set(info.texture, texture)
      }
      const geometry = new THREE.BufferGeometry()
      const values = new Float32Array(buffer, part.vertexOffset, part.vertexBytes / 4)
      const interleaved = new THREE.InterleavedBuffer(values, part.stride)
      const attrs = [['position',3,0],['uv',2,3],['blinkL',3,5],['blinkR',3,8],
        ['mouth',3,11],['skin',4,14],['lash',1,18],['hairUv',2,19],
        ['hairMask',2,21],['rest',3,23],['mouthColor',4,26],
        ['jointIndices',4,30],['jointWeights',4,34],['secondary',2,38]]
      for (const [name,size,offset] of attrs) {
        geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(interleaved,size,offset))
      }
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer,part.indexOffset,part.count),1))
      const texture = this.textures.get(info.texture)
      const material = new AvatarMaterial(THREE,info,texture,this.controls,this.motion).material
      const mesh = new THREE.Mesh(geometry,material)
      mesh.frustumCulled = false
      this.figure.add(mesh)
    }
    this.manifest = manifest
    this.resize_view()
    this.loaded = true
    this.renderer.setAnimationLoop(time => this.render_frame(time))
    return { bytes: manifest.bytes, parts: manifest.parts.length,
      bones:manifest.skeleton.length, sourceSha256: manifest.sourceSha256 }
  }

  /** 无参数；根据容器调整正交相机，窗口变化不修改用户数据。 */
  resize_view() {
    const width = this.host.clientWidth
    const height = this.host.clientHeight
    if (!width || !height) return
    this.renderer.setSize(width,height)
    // 竖向大幅展示上半身；窄容器保持最小横向取景，避免裁掉头发与袖口。
    const span = Math.max(.39, .29 * height / width)
    this.camera.left = -span * width / height / 2
    this.camera.right = -this.camera.left
    this.camera.top = span / 2
    this.camera.bottom = -span / 2
    this.camera.updateProjectionMatrix()
  }

  /** 参数time为单调时间；仅在可见时更新眨眼、骨骼待机、发梢弹簧及显式口型预览。 */
  render_frame(time) {
    if (this.disposed || this.paused || document.hidden || !this.host.offsetWidth) return
    if (time - this.last < 1000 / 30) return
    const dt = this.last ? Math.min(.05,(time-this.last)/1000) : 0
    this.last = time
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (time >= this.nextBlink && !this.blinkStart) {
      this.blinkStart = time
      this.nextBlink = time + 3200 + Math.random() * 3400
    }
    const elapsed = this.blinkStart ? time - this.blinkStart : 999
    const ease = value => value*value*(3-2*value)
    const blink = elapsed < 80 ? ease(elapsed/80) :
      elapsed < 125 ? 1 : elapsed < 275 ? 1-ease((elapsed-125)/150) : 0
    if (elapsed >= 275) this.blinkStart = 0
    const mouth = time < this.speakUntil ? Math.max(0,Math.sin(time*.018))*.72 : 0
    if (this.manual) this.controls.value.set(...this.manual)
    else this.controls.value.set(blink,blink,mouth)
    this.motion.update_motion(dt,Boolean(this.manual),reduced)
    this.renderer.render(this.scene,this.camera)
    this.frameCount++
  }

  /** 参数state为[left,right,mouth]或null；供显式预览和像素验收，不触发任何模型调用。 */
  set_preview(state) {
    this.manual = state ? state.map(v => Math.min(1,Math.max(0,v))) : null
  }

  /** 无参数；展示三秒口型试播，明确为动画预览，不伪装成TTS输出。 */
  preview_speech() { this.manual = null; this.speakUntil = performance.now()+3000 }

  /** 无参数；释放GPU资源和监听，避免页面反复打开累积上下文。 */
  dispose_view() {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resize.disconnect()
    document.removeEventListener('visibilitychange',this.visibility)
    for (const mesh of this.figure.children) { mesh.geometry.dispose(); mesh.material.dispose() }
    for (const texture of this.textures.values()) texture.dispose()
    this.motion?.dispose_motion()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
