/**
 * 控制台交互反馈：为用户触发的真实请求提供等待条、按钮防重复与可关闭的错误提示。
 * 注册参数 doc 为页面文档，默认 document；不包装全局 fetch，不跟踪定时心跳，不保存表单或凭据。
 */
class ConsoleInteractions {
  /** 参数 doc：页面文档；绑定捕获阶段，识别本轮点击触发的请求，默认不显示等待界面。 */
  constructor(doc = document) {
    this.doc = doc
    this.action = null
    this.pending = 0
    this.bar = doc.getElementById('request-progress')
    this.note = doc.getElementById('request-feedback')
    this.text = doc.getElementById('request-feedback-text')
    this.scroll = new Map()
    doc.querySelector('#tabs button.active')?.setAttribute('aria-current', 'page')
    doc.addEventListener('click', event => this.capture_action(event), true)
    doc.addEventListener('submit', event => this.capture_action(event), true)
    doc.getElementById('request-feedback-close').addEventListener('click', () => { this.note.hidden = true })
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        this.note.hidden = true
        doc.querySelectorAll('details[open]').forEach(item => { item.open = false })
      }
    })
  }

  /** 参数 message：停止等危险动作的说明；使用自绘对话框，取消或 Escape 均返回 false，并恢复原焦点。 */
  confirm_action(message) {
    const dialog = this.doc.getElementById('action-confirm')
    if (dialog.open) return Promise.resolve(false)
    const focused = this.doc.activeElement
    this.doc.getElementById('action-confirm-description').textContent = message
    dialog.returnValue = ''
    return new Promise(resolve => {
      dialog.addEventListener('close', () => {
        focused?.focus()
        resolve(dialog.returnValue === 'confirm')
      }, { once: true })
      dialog.showModal()
      this.doc.getElementById('action-confirm-cancel').focus()
    })
  }

  /** 参数 event：点击事件；已等待的按钮阻止重复提交，窗口按钮和导航不作为业务请求。 */
  capture_action(event) {
    const button = event.submitter || event.target.closest?.('button')
    if (!button) return
    if (button.getAttribute('aria-busy') === 'true') {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (button.closest('#tabs')) {
      const main = this.doc.querySelector('main')
      const active = this.doc.querySelector('#tabs button.active')
      if (active) this.scroll.set(active.dataset.tab, main.scrollTop)
      requestAnimationFrame(() => {
        this.doc.querySelectorAll('#tabs button').forEach(item => {
          if (item === button) item.setAttribute('aria-current', 'page')
          else item.removeAttribute('aria-current')
        })
        main.scrollTo({ top: this.scroll.get(button.dataset.tab) ?? 0, behavior: 'instant' })
      })
      return
    }
    if (button.closest('#desktop-titlebar, .opening-screen') || button.id === 'request-feedback-close') return
    const action = { button, count: 0 }
    this.action = action
    // 只归属当前事件同步发起的请求，避免把稍后的自动心跳误认为用户操作。
    setTimeout(() => { if (this.action === action) this.action = null }, 0)
  }

  /** 参数 operation：包含 HTTP、JSON 及业务错误检查的异步函数；仅为本轮用户操作显示真实等待状态。 */
  async run_request(operation) {
    const action = this.action
    if (!action) return operation()
    const button = action.button
    if (action.count++ === 0) {
      action.previous = button.getAttribute('aria-busy')
      button.setAttribute('aria-busy', 'true')
    }
    this.pending++
    if (this.pending === 1) this.note.hidden = true
    this.bar.hidden = false
    this.bar.setAttribute('aria-busy', 'true')
    try {
      return await operation()
    } catch (error) {
      // 失败不自动重试，不根据 HTTP 返回推断整个后台任务已经完成。
      this.text.textContent = `请求未完成：${String(error.message || error).slice(0, 180)}`
      this.note.hidden = false
      throw error
    } finally {
      if (--action.count === 0) {
        if (action.previous === null) button.removeAttribute('aria-busy')
        else button.setAttribute('aria-busy', action.previous)
      }
      if (--this.pending === 0) {
        this.bar.hidden = true
        this.bar.setAttribute('aria-busy', 'false')
      }
    }
  }
}

window.consoleInteractions = new ConsoleInteractions()
