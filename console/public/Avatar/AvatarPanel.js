/**
 * 人物陪伴卡片：组织自动待机人物与既有真实数据区，固定人物并独立滚动信息。
 * 参数doc默认document；仅移动现有概览DOM，不增加业务接口、不发送消息、不复制任务状态。
 */
import { AvatarRenderer } from './AvatarRenderer.js'

export class AvatarPanel {
  /** 参数doc为当前控制台文档；初始化卡片、错误回退与入口可见性。 */
  constructor(doc = document) {
    this.doc = doc
    const panel = doc.getElementById('tab-overview')
    if (!panel) return
    const details = doc.createElement('div')
    details.className = 'companion-information'
    for (const child of [...panel.children]) details.append(child)
    const heading = doc.createElement('div')
    heading.className = 'companion-information-heading'
    heading.innerHTML = '<h2>日常一览</h2>'
    const refresh = doc.getElementById('dashboard-refresh')
    if (refresh) heading.append(refresh)
    details.prepend(heading)
    panel.classList.add('companion-overview')
    panel.append(details)
    const card = doc.createElement('section')
    card.className = 'companion-card'
    card.setAttribute('aria-label','欣爱人物展示')
    card.innerHTML = `
      <div class="companion-heading"><div><span class="companion-eyebrow">SYNLOVE</span><h2>欣爱</h2></div>
        <span class="companion-label">与你相伴</span></div>
      <div class="companion-stage" aria-label="欣爱三维人物">
        <div class="companion-halo"></div><div class="companion-canvas"></div>
        <p class="companion-load" role="status">正在载入欣爱…</p>
      </div>
      <div class="companion-footer">
        <img class="companion-brand" src="/Avatar/assets/AvatarSignature.png" alt="SynLove" width="160" height="58" />
        <span class="companion-motto">心合万象 爱有回响</span>
      </div>`
    panel.prepend(card)
    this.card = card
    this.status = card.querySelector('.companion-load')
    const host = card.querySelector('.companion-canvas')
    host.addEventListener('pointermove', event => {
      const box = host.getBoundingClientRect()
      this.avatar?.motion?.set_pointer((event.clientX-box.left)/box.width*2-1,
        (event.clientY-box.top)/box.height*2-1)
    })
    host.addEventListener('pointerleave', () => this.avatar?.motion?.set_pointer(null,null))
    host.addEventListener('avatar:error', event => this.show_error(event.detail))
    host.addEventListener('avatar:restored', () => { this.status.hidden = true })
    card.addEventListener('wheel', event => {
      if (event.ctrlKey || !matchMedia('(min-width: 851px)').matches) return
      if (details.scrollHeight<=details.clientHeight) return
      const scale = event.deltaMode===1 ? 20 : event.deltaMode===2 ? details.clientHeight : 1
      details.scrollTop += event.deltaY*scale
      event.preventDefault()
    }, {passive:false})
    this.observer = new IntersectionObserver(entries => {
      if (this.avatar) this.avatar.paused = !entries[0].isIntersecting
    })
    this.observer.observe(card)
    this.initialize_view(host)
  }

  /** 参数host为画布容器；读取本机资源，失败时保留所有控制台功能并显示原模型静态图。 */
  async initialize_view(host) {
    try {
      this.avatar = new AvatarRenderer(host)
      this.info = await this.avatar.load_model()
      this.status.hidden = true
      this.status.textContent = ''
      this.card.dataset.ready = 'true'
    } catch (error) { this.show_error(error.message) }
  }

  /** 参数message为实际错误；显式说明三维预览不可用，禁止伪造成功状态。 */
  show_error(message) {
    this.card.dataset.ready = 'error'
    this.avatar && (this.avatar.paused = true)
    this.card.querySelector('.companion-stage').classList.add('companion-fallback')
    this.status.hidden = false
    this.status.textContent = `三维预览暂不可用：${message}`
  }

}

window.synloveAvatarPanel = new AvatarPanel()
