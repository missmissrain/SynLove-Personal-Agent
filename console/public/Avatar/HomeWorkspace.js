/**
 * 主页信息编排器：把连接、安排、服务与动态组织为按需切换的工作区，复用原有真实数据节点。
 * 注册参数host为信息容器、doc默认document；默认展示今日安排，不新增接口或修改业务状态。
 */
export class HomeWorkspace {
  /** 参数host、doc为现有容器及所属文档；移动原节点并建立可键盘操作的页签。 */
  constructor(host, doc = document) {
    this.host = host
    const old = host.querySelector('.overview-workspace')
    if (!old) return
    this.sections = [
      ['today', '今日安排', old.querySelector('.overview-schedules')],
      ['services', '能力与服务', old.querySelector('.service-panel')],
      ['activity', '最近动态', old.querySelector('.overview-activity')],
    ].filter(row => row[2])
    this.tabs = doc.createElement('div')
    this.tabs.className = 'companion-view-tabs'
    this.tabs.setAttribute('role', 'tablist')
    this.tabs.setAttribute('aria-label', '主页内容')
    const workspace = doc.createElement('section')
    workspace.className = 'companion-focus'
    workspace.append(this.tabs)
    for (const [id, label, panel] of this.sections) {
      const button = doc.createElement('button')
      button.id = `home-view-${id}`
      button.type = 'button'
      button.textContent = label
      button.dataset.homeView = id
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-controls', `home-panel-${id}`)
      button.addEventListener('click', () => this.select_view(id))
      button.addEventListener('keydown', event => this.move_focus(event, id))
      this.tabs.append(button)
      panel.id = `home-panel-${id}`
      panel.classList.add('companion-focus-panel')
      panel.setAttribute('role', 'tabpanel')
      panel.setAttribute('aria-labelledby', button.id)
      panel.tabIndex = 0
      workspace.append(panel)
    }
    old.replaceWith(workspace)
    const stats = host.querySelector('.dashboard-stats')
    if (stats) host.append(stats)
    this.select_view('today')
  }

  /** 参数id为今日、服务或动态页面标识；只改变显示，不停止现有数据刷新。 */
  select_view(id) {
    if (!this.sections.some(row => row[0] === id)) return
    for (const [key, , panel] of this.sections) {
      const selected = key === id
      const button = this.tabs.querySelector(`[data-home-view="${key}"]`)
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
      panel.hidden = !selected
    }
    this.host.dataset.homeView = id
  }

  /** 参数event为键盘事件、id为当前页；方向键及Home、End移动页签并切换内容。 */
  move_focus(event, id) {
    const keys = this.sections.map(row => row[0])
    const i = keys.indexOf(id)
    const next = event.key === 'ArrowRight' ? (i + 1) % keys.length :
      event.key === 'ArrowLeft' ? (i + keys.length - 1) % keys.length :
      event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    this.select_view(keys[next])
    this.tabs.querySelector(`[data-home-view="${keys[next]}"]`).focus()
  }
}
