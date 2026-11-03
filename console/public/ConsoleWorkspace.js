/**
 * 工作区导航：管理页内人格分类、面包屑和诊断分组的展开，不新增业务状态或接口。
 * 注册参数 doc 为页面文档，默认 document；页内切换只隐藏容器，不重建或丢弃未保存的输入。
 */
class ConsoleWorkspace {
  /** 参数 doc：现有控制台文档；注册主导航与支持键盘切换的三个人格分类。 */
  constructor(doc = document) {
    this.doc = doc
    doc.querySelectorAll('#tabs button').forEach(button => {
      button.addEventListener('click', () => this.open_page(button))
    })
    this.bind_tabs('[data-agent-view]')
    this.bind_tabs('[data-remote-view]')
  }

  /** 参数 selector：同一组页内分类按钮；为各组分别绑定切换和键盘事件，互不改变另一组的状态。 */
  bind_tabs(selector) {
    const tabs = Array.from(this.doc.querySelectorAll(selector))
    tabs.forEach((button, index) => {
      button.addEventListener('click', () => this.open_view(button, tabs))
      button.addEventListener('keydown', event => this.move_view(event, index, tabs))
    })
  }

  /** 参数 button：主导航目标；通过直接入口访问诊断页时展开所属分组，更新位置提示。 */
  open_page(button) {
    const group = button.closest('details')
    if (group) group.open = true
    const page = button.dataset.tab
    const category = ['overview', 'agent', 'memory'].includes(page) ? '日常'
      : ['models', 'toggles', 'weixin', 'qq', 'remote'].includes(page) ? '连接与能力' : '运行与诊断'
    this.doc.getElementById('page-category').textContent = category
  }

  /** 参数 button/tabs：页内目标和所属分类组；同步选中态与面板可见性，输入内容保持原样。 */
  open_view(button, tabs) {
    for (const item of tabs) {
      const active = item === button
      item.classList.toggle('active', active)
      item.setAttribute('aria-selected', String(active))
      item.tabIndex = active ? 0 : -1
      this.doc.getElementById(item.getAttribute('aria-controls')).hidden = !active
    }
  }

  /** 参数 event/index/tabs：键盘事件、当前索引和分类组；左右循环切换，Home/End 到首尾。 */
  move_view(event, index, tabs) {
    const moves = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0, End: tabs.length - 1 }
    if (!(event.key in moves)) return
    event.preventDefault()
    const button = tabs[moves[event.key]]
    this.open_view(button, tabs)
    button.focus()
  }
}

new ConsoleWorkspace()
