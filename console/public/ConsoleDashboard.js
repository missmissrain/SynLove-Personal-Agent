/**
 * ConsoleDashboard：控制台概览的只读聚合展示，不维护业务状态或新增服务消费者。
 * 注册参数：页面 dashboard-* 元素与 app.js 的同源 get/refresh_overview；默认一分钟刷新一次观测统计。
 * 服务状态复用 synlove:overview 事件；用量、趋势、后台动态和消息通道读取同源只读接口。
 */
class ConsoleDashboard {
  /** 无参数；绑定页面、概览事件与按需导航，发起只读统计加载。 */
  constructor() {
    this.busy = false
    document.addEventListener('synlove:overview', event => this.render_overview(event.detail))
    document.addEventListener('synlove:overview-error', () => {
      const target = document.getElementById('dashboard-checked')
      target.hidden = false
      target.textContent = '服务状态暂不可用，当前显示上次结果'
    })
    document.querySelectorAll('[data-open-tab]').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelector(`#tabs button[data-tab="${button.dataset.openTab}"]`)?.click()
        button.closest('details')?.removeAttribute('open')
      })
    })
    document.getElementById('dashboard-refresh').addEventListener('click', async () => {
      const button = document.getElementById('dashboard-refresh')
      button.disabled = true
      try {
        await Promise.all([refresh_overview(), this.refresh_stats()])
      } catch (error) {
        document.getElementById('status-strip').textContent = `刷新失败：${error.message}`
      } finally { button.disabled = false }
    })
    document.querySelectorAll('#tabs button').forEach(button => {
      button.addEventListener('click', () => {
        if (['overview', 'system'].includes(button.dataset.tab)) this.refresh_stats()
      })
    })
    this.render_date()
    this.refresh_stats()
    setInterval(() => {
      this.render_date()
      if (!document.hidden && ['tab-overview', 'tab-system'].some(id => document.getElementById(id).classList.contains('active'))) this.refresh_stats()
    }, 60_000)
  }

  /** 无参数；使用本机日期更新顶栏，避免写死样板日期。 */
  render_date() {
    const date = new Date()
    const target = document.getElementById('console-date')
    target.dateTime = date.toISOString()
    target.textContent = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  }

  /** 参数 data：overview 原始响应；展示账本、记忆和服务状态，不推断微信凭据有效性。 */
  render_overview(data) {
    document.getElementById('dashboard-deliveries').textContent = num(data.deliveries)
    document.getElementById('dashboard-memory').textContent = `${num(data.memory.timeline_days)} 天`
    document.getElementById('dashboard-memory-note').textContent = `最近 ${data.memory.last_day ?? '暂无记录'}`
    document.getElementById('dashboard-checked').hidden = true
  }

  /** 无参数；独立读取用量、工具调用与最近记录，各区块失败时不伪造零值。 */
  async refresh_stats() {
    if (this.busy) return
    this.busy = true
    try {
      await Promise.allSettled([
        this.load_usage(),
        this.load_tools(),
        this.load_portal(),
      ])
    } finally { this.busy = false }
  }

  /** 无参数；读取近 24 小时探针用量，按实际字段展示缓存输入与未缓存输入。 */
  async load_usage() {
    try {
      const data = await get('/api/usage?days=1')
      const total = data.total ?? {}
      const tokens = total.totalTokens ?? ((total.input ?? 0) + (total.cacheRead ?? 0) + (total.output ?? 0))
      document.getElementById('dashboard-tokens').textContent = num(tokens)
      document.getElementById('dashboard-token-note').textContent = `${num(total.calls)} 次模型调用 · 来自用量探针`
      const parts = [['未缓存输入', total.input ?? 0], ['缓存输入', total.cacheRead ?? 0], ['输出', total.output ?? 0]]
      const sum = parts.reduce((value, part) => value + part[1], 0)
      document.getElementById('dashboard-token-chart').innerHTML = sum
        ? parts.map(([label, value]) => `<div class="distribution-row"><span>${label}</span><meter min="0" max="${sum}" value="${value}" aria-label="${label}"></meter><strong>${num(value)}</strong></div>`).join('')
        : '<div class="empty-state">近 24 小时没有用量记录</div>'
    } catch (error) {
      document.getElementById('dashboard-tokens').textContent = '—'
      document.getElementById('dashboard-token-note').textContent = `读取失败：${error.message}`
      document.getElementById('dashboard-token-chart').textContent = '用量暂不可用'
    }
  }

  /** 无参数；读取统一观测统计，工具次数仅代表已采集的数据。 */
  async load_tools() {
    try {
      const data = await get('/api/observations/trends?days=1')
      document.getElementById('dashboard-tools').textContent = num(data.summary.toolCalls)
      document.getElementById('dashboard-tool-note').textContent = '已采集的工具执行次数'
    } catch (error) {
      document.getElementById('dashboard-tools').textContent = '—'
      document.getElementById('dashboard-tool-note').textContent = `读取失败：${error.message}`
    }
  }

  /** 参数 rows：提醒与系统任务；按真实触发时间渲染行，不在界面模拟下一次运行时间。 */
  render_schedules(rows) {
    const labels = { pending: '待执行', Ready: '已启用', Running: '运行中', Disabled: '已停用', Unknown: '状态未知', running: '后台运行' }
    return rows.length ? rows.map(row => {
      const at = new Date(row.nextAt)
      const next = row.status === 'Disabled' || row.state === 'Disabled' ? '已停用' : Number.isFinite(at.getTime()) && at.getFullYear() > 2000
        ? at.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '按后台条件触发'
      return `<div class="schedule-row"><div><strong>${escape_service(row.name)}</strong><div class="hint">${escape_service(row.rule)} · ${escape_service(row.source)}</div></div><div class="schedule-time">${escape_service(next)}<div class="hint">${escape_service(labels[row.status ?? row.state] || '待确认')}</div></div></div>`
    }).join('') : '<div class="empty-state">暂无已配置的任务</div>'
  }

  /** 无参数；读取真实后台活动、定时任务和消息通道，失败时不展示伪造在线状态。 */
  async load_portal() {
    try {
      const data = await get('/api/dashboard')
      const target = document.getElementById('dashboard-recent')
      target.classList.toggle('empty-state', !data.activities.length)
      target.innerHTML = data.activities.length ? data.activities.slice(0, 8).map(item => `
        <div class="activity-row"><time>${escape_service(new Date(item.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time>
        <div>${escape_service(item.text)}</div></div>`).join('') : '暂无后台更新记录'
      const channels = document.getElementById('dashboard-channels')
      channels.classList.remove('empty-state')
      const styles = {
        weixin: { icon: '💬', css: 'channel-weixin', description: 'iLink 协议' },
        qq: { icon: '🐧', css: 'channel-qq', description: '官方 API · 群@+私聊' },
      }
      channels.innerHTML = data.channels.filter(channel => ['weixin', 'qq'].includes(channel.id)).map(channel => {
        const style = styles[channel.id] ?? { icon: '◇', css: '', description: channel.name }
        return `<button class="channel-button" data-channel="${escape_service(channel.tab)}" title="${escape_service(channel.detail)}"><span class="connection-icon ${style.css}" aria-hidden="true">${style.icon}</span><span class="channel-description"><strong>${escape_service(channel.name)}</strong><span class="hint">${escape_service(style.description)}</span></span><span class="channel-status ${channel.status === 'connected' ? 'state-ok' : 'state-incomplete'}">${escape_service(channel.status === 'connected' ? '在线' : channel.label)}</span></button>`
      }).join('')
      channels.querySelectorAll('[data-channel]').forEach(button => button.addEventListener('click', () => {
        if (['weixin', 'qq', 'agent'].includes(button.dataset.channel)) document.querySelector(`#tabs button[data-tab="${button.dataset.channel}"]`).click()
      }))
      document.getElementById('dashboard-channel-time').textContent = `更新于 ${new Date(data.at).toLocaleTimeString('zh-CN')}`
      document.getElementById('dashboard-schedules').classList.remove('empty-state')
      document.getElementById('dashboard-schedules').innerHTML = this.render_schedules(data.schedules)
      document.getElementById('dashboard-system-tasks').innerHTML = this.render_schedules(data.systemTasks)
      document.getElementById('dashboard-schedule-count').textContent = `${data.schedules.length} 项`
      document.getElementById('dashboard-schedule-note').textContent = data.errors.length ? data.errors.join('；') : ''
    } catch (error) {
      for (const id of ['dashboard-recent', 'dashboard-channels', 'dashboard-schedules', 'dashboard-system-tasks']) {
        const target = document.getElementById(id)
        target.classList.add('empty-state')
        target.textContent = `暂不可用：${error.message}`
      }
      document.getElementById('dashboard-channel-time').textContent = '读取失败'
      document.getElementById('dashboard-schedule-count').textContent = ''
    }
  }
}

new ConsoleDashboard()
