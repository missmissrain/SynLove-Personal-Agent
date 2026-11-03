/**
 * 调用链与运行趋势面板：查询观测副本、展示层级、耗时、错误与版本对照。
 * 注册参数：页面中的 obs-*、quality-* 元素；默认只在打开面板或手动刷新时请求数据。
 * 所有动态文本均转义，不主动调用模型、不触发服务启停。
 */
(() => {
  const el = id => document.getElementById(id)
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const number = value => Number(value ?? 0).toLocaleString('zh-CN')
  const percent = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`
  const duration = value => value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
  const costs = value => Object.entries(value ?? {}).map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(' · ') || '暂无估价'
  const status = value => ({ ok: '执行结束', error: '失败', cancelled: '取消', incomplete: '未完整记录' })[value] ?? '未完整记录'
  let page = 1
  let total = 0
  let listGeneration = 0
  let detailGeneration = 0
  let trendGeneration = 0
  const titles = {
    overview: ['概览', '查看服务、消息通道和后台动态。'],
    system: ['系统', '查看发送队列、后端守护和系统维护任务。'],
    observations: ['调用链', '沿着一次请求，找到慢在哪里、错在哪里。'],
    quality: ['运行趋势', '查看调用耗时、错误率、用量与提示词版本表现。'],
    models: ['模型选择', '为不同的工作，选择合适的能力。'],
    toggles: ['功能设置', '按需要开启，让系统保持简单。'],
    agent: ['人格与工具', '她的表达习惯，以及能帮你做的事。'],
    weixin: ['微信绑定', '保持消息通路连接。'], qq: ['QQ 通道', '查看账号与通道状态。'],
    remote: ['服务与远控', '连接后台服务，或控制其他电脑。'],
    memory: ['记忆维护', '管理长期记忆、人物关系与当前上下文。'],
    usage: ['Token 用量', '看清每一次调用的资源消耗。'], logs: ['日志', '需要更细的线索时，从这里查起。'],
  }

  /** 参数 path/options：本机 API 请求；失败时使用服务端错误信息。 */
  async function request(path, options) {
    return window.consoleInteractions.run_request(async () => {
      const response = await fetch(path, { cache: 'no-store', ...options })
      const data = await response.json()
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    })
  }

  /** 参数 health：采集健康信息；显示数据缺口而不是伪装完整观测。 */
  function health_text(health = {}) {
    return [
      health.remote?.note ?? '仅本地记录',
      health.historical ? `${number(health.historical)} 条历史补录，链路字段不完整` : '',
      health.truncated ? '当前窗口受保留/读取上限限制' : '',
      health.malformed ? `${number(health.malformed)} 条记录无法解析` : '',
      health.droppedEvents ? `采集器报告丢弃 ${number(health.droppedEvents)} 条事件` : '',
    ].filter(Boolean).join(' · ')
  }

  /** 参数 headers/rows：列标题与已转义单元格；生成可横向滚动的表格。 */
  function table(headers, rows) {
    return rows.length ? `<table><thead><tr>${headers.map(text => `<th>${esc(text)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty-state">还没有符合条件的记录。新调用产生后会显示在这里。</div>'
  }

  /** 无参数；按过滤条件加载一页调用链，忽略晚到的旧请求。 */
  async function load_list() {
    const generation = ++listGeneration
    const query = new URLSearchParams({ q: el('obs-search').value, status: el('obs-status').value, days: el('obs-days').value, page: String(page) })
    el('obs-health').textContent = '正在读取记录…'
    try {
      const data = await request(`/api/observations?${query}`)
      if (generation !== listGeneration) return
      total = data.total
      el('obs-health').textContent = health_text(data.health)
      el('obs-list').innerHTML = table(['时间 / 会话', '模型', '执行情况', '调用', '耗时', ''], data.items.map(item => [
        `<span class="table-main">${esc(time(item.startedAt))}</span><code class="muted-code">${esc(item.sessionId ?? item.traceId)}</code>`,
        esc(item.models.join('、') || '尚无模型记录'),
        `<span class="state-pill state-${esc(item.status)}">${esc(status(item.status))}</span>${item.errors ? `<span class="hint"> ${number(item.errors)} 个失败片段</span>` : ''}`,
        `${number(item.modelCalls)} 模型 · ${number(item.toolCalls)} 工具`,
        esc(duration(item.durationMs)),
        `<button class="trace-open" data-trace="${esc(item.traceId)}">查看</button>`,
      ]))
      el('obs-page').textContent = `${number(total)} 条 · 第 ${page} 页`
      el('obs-prev').disabled = page <= 1
      el('obs-next').disabled = page * 50 >= total
    } catch (error) { if (generation === listGeneration) el('obs-health').textContent = `读取失败：${error.message}` }
  }

  /** 参数 trace_id：选中的调用链；构建真实父子关系并标注缺失片段。 */
  async function load_detail(trace_id) {
    const generation = ++detailGeneration
    const target = el('obs-detail')
    target.hidden = false
    target.textContent = '正在读取调用链…'
    try {
      const data = await request(`/api/observations/detail?traceId=${encodeURIComponent(trace_id)}`)
      if (generation !== detailGeneration) return
      const ids = new Set(data.spans.map(span => span.spanId))
      const render = (parent, seen = new Set()) => {
        if (seen.size > 32) return '<li class="hint">层级过深，已停止展开。</li>'
        const children = data.spans.filter(span => parent ? span.parentSpanId === parent : !span.parentSpanId || !ids.has(span.parentSpanId))
        return `<ol class="span-tree">${children.map(span => {
          if (seen.has(span.spanId)) return ''
          const next = new Set(seen).add(span.spanId)
          return `<li><div class="span-row"><div><span class="span-kind">${esc(span.kind)}</span><strong>${esc(span.name ?? span.model ?? span.kind)}</strong><span class="state-pill state-${esc(span.status)}">${esc(status(span.status))}</span>${span.partial ? '<span class="hint">起止记录不完整</span>' : ''}</div><span>${esc(duration(span.durationMs))}</span></div><div class="span-meta">${esc(time(span.startedAt ?? span.endedAt))}${span.ttftMs != null ? ` · 首字 ${esc(duration(span.ttftMs))}` : ''}${span.usage ? ` · ${number(span.usage.totalTokens)} tokens` : ''}${span.personaVersion ? ` · 人格 <code title="${esc(span.personaVersion)}">${esc(span.personaVersion.slice(0, 12))}</code>` : ''}${span.promptVersion ? ` · 系统 <code title="${esc(span.promptVersion)}">${esc(span.promptVersion.slice(0, 12))}</code>` : ''}</div>${render(span.spanId, next)}</li>`
        }).join('')}</ol>`
      }
      target.innerHTML = `<div class="section-heading"><h3>调用详情</h3><button id="obs-detail-close">收起</button></div><code class="trace-id">${esc(trace_id)}</code>${data.truncatedSpans ? '<p class="hint">当前仅展示前 1000 个执行片段。</p>' : ''}${data.spans.length ? render(undefined) : '<div class="empty-state">没有执行片段记录，可能已超出保留窗口。</div>'}
        ${data.events.length ? `<details><summary>通路事件（${data.events.length}）</summary>${table(['时间', '事件', '结果 / 耗时'], data.events.map(row => [esc(time(row.at)), esc(row.name ?? row.event ?? row.kind), esc(`${row.outcome ?? ''} ${duration(row.durationMs)}`)]))}</details>` : ''}`
      el('obs-detail-close').addEventListener('click', () => { detailGeneration++; target.hidden = true })
    } catch (error) { if (generation === detailGeneration) target.textContent = `读取失败：${error.message}` }
  }

  /** 无参数；展示趋势、版本统计和样本门槛，不将代理指标称为回答质量。 */
  async function load_trends() {
    const generation = ++trendGeneration
    el('quality-health').textContent = '正在汇总…'
    try {
      const data = await request(`/api/observations/trends?days=${el('quality-days').value}`)
      if (generation !== trendGeneration) return
      const summary = data.summary
      el('quality-health').textContent = health_text(data.health)
      el('quality-cards').innerHTML = [
        ['模型调用', number(summary.calls), data.health.historical && !summary.sessions ? '历史会话关联未记录' : `${number(summary.sessions)} 个会话`],
        ['模型执行错误率', percent(summary.errorRate), `${number(summary.errors)} 次错误 · ${number(summary.cancelled)} 次取消`],
        ['工具错误率', percent(summary.toolErrorRate), data.health.historical && !summary.toolCalls ? '历史工具执行结果未记录' : `${number(summary.toolCalls)} 次工具执行`],
        ['P95 模型耗时', duration(summary.p95Ms), '95% 已记录调用耗时不超过此值'],
        ['调用成本估算', costs(summary.costs), `${number(summary.unpricedCalls)} 次未估价 · 按本地价格表`],
      ].map(([title, value, caption]) => `<div class="service metric-card"><div class="name">${esc(title)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(caption)}</div></div>`).join('')
      // 兼容历史后端返回的评分告警；界面只展示自动采集的运行指标告警。
      const warnings = data.warnings.filter(text => !/人工评分|人工平均分/.test(text))
      el('quality-warnings').innerHTML = warnings.length ? warnings.map(text => `<p class="quality-notice">${esc(text)}</p>`).join('') : '<p class="quality-notice is-ok">当前运行指标未触发告警。</p>'
      const max = Math.max(1, ...data.daily.map(row => row.calls))
      el('quality-chart').innerHTML = data.daily.length ? data.daily.map(row => `<div class="trend-day"><span>${esc(row.date.slice(5))}</span><meter min="0" max="${max}" value="${row.calls}">${row.calls}</meter><strong>${number(row.calls)}</strong><span class="${row.errors ? 'error-text' : 'hint'}">${number(row.errors)} 错误</span></div>`).join('') : '<p class="empty-state">还没有趋势数据。</p>'
      el('quality-daily').innerHTML = table(['日期', '调用', '错误率', '工具错误率', 'P95', '成本估算'], data.daily.map(row => [esc(row.date), number(row.calls), percent(row.errorRate), percent(row.toolErrorRate), esc(duration(row.p95Ms)), esc(costs(row.costs))]))
      el('quality-versions').innerHTML = table(['模型', '提示词 / 工具指纹', '调用', '错误率', 'P95'], data.versions.map(row => [
        `<span class="table-main">${esc(row.model)}</span><span class="hint">${esc(row.provider)}</span>`,
        `<code title="${esc(row.personaVersion ?? row.promptVersion)}">${esc((row.personaVersion ?? row.promptVersion)?.slice(0, 12) ?? '未记录')}</code> <span class="hint">${row.personaVersion ? '人格' : '系统'}</span><br><code class="muted-code" title="${esc(row.toolsVersion)}">${esc(row.toolsVersion?.slice(0, 12) ?? '未记录')}</code><span class="hint"> · ${number(row.systemVariants)} 种系统指纹</span>`,
        number(row.calls), percent(row.errorRate), esc(duration(row.p95Ms)),
      ]))
    } catch (error) { if (generation === trendGeneration) el('quality-health').textContent = `汇总失败：${error.message}` }
  }

  /** 参数 tab：目标标签；更新标题，按需读取观测数据。 */
  function open_tab(tab) {
    const title = titles[tab]
    if (title) {
      el('page-title').textContent = title[0]
      el('page-heading-title').textContent = tab === 'overview' ? '欢迎回来' : title[0]
      el('page-description').textContent = title[1]
    }
    if (tab === 'observations') load_list()
    if (tab === 'quality') load_trends()
  }
  document.querySelectorAll('#tabs button').forEach(button => button.addEventListener('click', () => open_tab(button.dataset.tab)))
  el('obs-refresh').addEventListener('click', load_list)
  el('obs-prev').addEventListener('click', () => { if (page > 1) { page--; load_list() } })
  el('obs-next').addEventListener('click', () => { if (page * 50 < total) { page++; load_list() } })
  for (const id of ['obs-status', 'obs-days']) el(id).addEventListener('change', () => { page = 1; load_list() })
  el('obs-search').addEventListener('keydown', event => { if (event.key === 'Enter') { page = 1; load_list() } })
  el('obs-list').addEventListener('click', event => {
    const button = event.target.closest('.trace-open')
    if (button) load_detail(button.dataset.trace)
  })
  el('quality-refresh').addEventListener('click', load_trends)
  el('quality-days').addEventListener('change', load_trends)
})()
