/**
 * 说明浮层模块：统一工具和设置问号的悬停、键盘聚焦、点击与关闭行为。
 * 注册参数 root：事件委托根节点，默认 document；说明从 data-help 读取，仅作为纯文本展示。
 * 浮层挂到 body 并使用浏览器顶层，默认距视口边缘 12px，不改变任何设置值。
 */
class ConsoleTooltip {
  /** 参数 root：页面文档；建立唯一浮层并绑定委托事件，支持异步生成的问号。 */
  constructor(root = document) {
    this.root = root
    this.active = null
    this.timer = null
    this.box = root.createElement('div')
    this.box.id = 'console-tooltip'
    this.box.className = 'console-tooltip'
    this.box.setAttribute('role', 'tooltip')
    this.box.setAttribute('popover', 'manual')
    this.box.hidden = true
    root.body.append(this.box)
    root.addEventListener('pointerover', event => this.open_event(event))
    root.addEventListener('focusin', event => this.open_event(event))
    root.addEventListener('pointerout', event => this.leave_event(event))
    root.addEventListener('focusout', event => this.leave_event(event))
    root.addEventListener('click', event => {
      if (event.target.closest('.tool-help[data-help]')) this.open_event(event)
      else if (!this.box.contains(event.target)) this.hide_tooltip()
    })
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.hide_tooltip()
    })
    root.addEventListener('scroll', event => {
      if (this.active && event.target !== this.box && !this.box.contains(event.target)) this.position_tooltip()
    }, true)
    window.addEventListener('resize', () => this.hide_tooltip())
  }

  /** 参数 event：悬停、聚焦或点击事件；显示问号的完整说明，进入浮层时取消关闭。 */
  open_event(event) {
    if (this.box.contains(event.target)) { clearTimeout(this.timer); return }
    const target = event.target.closest('.tool-help[data-help]')
    if (!target) return
    clearTimeout(this.timer)
    if (this.active === target && !this.box.hidden) return
    this.hide_tooltip()
    this.active = target
    target.setAttribute('aria-describedby', this.box.id)
    this.box.textContent = target.dataset.help || '暂无说明'
    this.box.hidden = false
    if (this.box.showPopover) this.box.showPopover()
    this.position_tooltip()
  }

  /** 无参数；随页面滚动重新定位，触发器离开视口时关闭，避免自动滚动误关点击提示。 */
  position_tooltip() {
    if (!this.active) return
    const rect = this.active.getBoundingClientRect()
    if (!this.active.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) {
      this.hide_tooltip()
      return
    }
    const width = this.box.offsetWidth
    const height = this.box.offsetHeight
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
    const below = rect.bottom + 8
    const top = below + height <= window.innerHeight - 12
      ? below : Math.max(12, rect.top - height - 8)
    this.box.style.left = `${left}px`
    this.box.style.top = `${top}px`
  }

  /** 参数 event：离开触发器或浮层的事件；保留短暂移动时间以便阅读、选择及滚动长说明。 */
  leave_event(event) {
    if (!this.active) return
    const next = event.relatedTarget
    if (next instanceof Node && (this.active.contains(next) || this.box.contains(next))) return
    if (event.target.closest('.tool-help[data-help]') || this.box.contains(event.target)) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.hide_tooltip(), 160)
    }
  }

  /** 无参数；清除描述关联并关闭浮层，允许 Escape、切页和窗口缩放立即收起。 */
  hide_tooltip() {
    clearTimeout(this.timer)
    this.active?.removeAttribute('aria-describedby')
    this.active = null
    if (this.box.hidePopover && this.box.matches(':popover-open')) this.box.hidePopover()
    this.box.hidden = true
  }
}

new ConsoleTooltip()
