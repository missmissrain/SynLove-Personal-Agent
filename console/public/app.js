/* Agent 控制台 · 前端逻辑（原生 JS，无构建步骤） */

const $ = id => document.getElementById(id)

async function get(path) {
  const response = await fetch(path, { cache: 'no-store' })
  const data = await response.json()
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = await response.json()
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

const num = value => (value ?? 0).toLocaleString('zh-CN')
const money = value => `¥${(value ?? 0).toFixed(4)}`
const escape_service = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// ── 标签页 ─────────────────────────────────────────────────────────────────

for (const button of document.querySelectorAll('#tabs button')) {
  button.addEventListener('click', () => {
    for (const item of document.querySelectorAll('#tabs button')) item.classList.toggle('active', item === button)
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`)
    }
    // 每个面板在切换到它时才去取数据（避免开页面就并发打一堆请求）
    if (button.dataset.tab === 'logs') refresh_log()
    if (button.dataset.tab === 'usage') refresh_usage()
    if (button.dataset.tab === 'memory') load_memory(false)
    if (button.dataset.tab === 'toggles') refresh_compaction().catch(() => {})
    if (button.dataset.tab === 'models') refresh_failover().catch(() => {})
    if (button.dataset.tab === 'qq') refresh_qq().catch(error => { $('qq-status').textContent = `读取失败：${error.message}` })
    if (button.dataset.tab === 'agent') {
      refresh_persona().catch(() => {})
      refresh_tools().catch(error => { $('tools-hint').textContent = `读取工具列表失败：${error.message}` })
    }
  })
}

// ── 服务状态 ───────────────────────────────────────────────────────────────

/** 参数 service：后端探活项；将技术服务名称映射为适合主页阅读的名称与职责说明。 */
function service_info(service) {
  if (service.port === 3080) return { name: 'Harness', role: '运行智能体与长任务' }
  if (service.port === 3081) return { name: '消息接入', role: '接收消息与任务指令' }
  if (service.port === 4096) return { name: 'OpenCode', role: '执行编程任务' }
  const roles = {
    TTS: { name: 'TTS', role: '将文字合成为语音' },
    ASR: { name: 'ASR', role: '将语音识别为文字' },
    LLM: { name: 'LLM', role: '对话理解与后台推理' },
    CORE: { name: '核心控制', role: '远程管理系统启动、停止与配置' },
    REMINDERS: { name: '定时提醒', role: '保存提醒并在到点时推送' },
    DIGEST: { name: '新闻摘要', role: '采集新闻并生成定时摘要' },
    VIDEO: { name: '视频理解', role: '转写语音、分析画面并生成报告' },
    HISTORY: { name: '历史检索', role: '查找过去的对话与会话记录' },
    CODING: { name: '编程调度', role: '通过接口派发编程任务' },
    CRAWLER: { name: '网页采集', role: '抓取网页并提取正文' },
    MEMORY: { name: '长期记忆', role: '读写每日时间线与人物关系图谱' },
    STATE: { name: '微信状态', role: '维护微信租约、收件记录与发送队列' },
    QQSTATE: { name: 'QQ 状态', role: '维护 QQ 租约与消息发送进度' },
    OBSERVATION: { name: '运行观测', role: '保存调用链、用量与错误记录' },
    SESSION: { name: '会话存储', role: '保存和读取 Harness 会话事件' },
    RSSHUB: { name: 'RSSHub', role: '将信息源转换为新闻订阅' },
    OPENCODE: { name: 'OpenCode', role: '执行编程任务' },
  }
  return roles[String(service.name).toUpperCase()] ?? { name: service.name, role: '自定义扩展服务' }
}

async function refresh_overview() {
  const data = await get('/api/overview')
  $('service-cards').innerHTML = data.services.map(service => {
    const info = service_info(service)
    const available = service.available ?? service.up
    const labels = { standby: '可按需调用', inactive: '本地模式', disabled: '已关闭', pending: '等待调用' }
    const label = labels[service.readiness] ?? (available ? '可调用' : '未就绪')
    const detail = `${label}：${service.detail || (available ? '服务已就绪' : '后端尚未启动')}`
    return `
    <div class="service">
      <div class="name"><span class="service-dot ${available ? 'is-up' : 'is-down'}" role="img" aria-label="${label}"></span>${escape_service(info.name)}${tool_help(detail)}</div>
      <div class="hint">${escape_service(info.role)}</div>
    </div>`
  }).join('')

  const up = data.services.filter(service => service.available ?? service.up).length
  $('status-strip').textContent =
    `${up}/${data.services.length} 项服务可用`

  $('outbox').innerHTML = data.outbox.length === 0
    ? '<span class="hint">队列为空</span>'
    : `<table><tr><th>状态</th><th>类型</th><th class="num">数量</th></tr>${data.outbox.map(row => `
        <tr><td>${escape_service(row.status)}</td><td>${escape_service(row.kind)}</td><td class="num">${num(row.n)}</td></tr>`).join('')}</table>`

  $('memory').innerHTML = `
    <table>
      <tr><td>时间线</td><td class="num">${num(data.memory.timeline_days)} 天（最近 ${escape_service(data.memory.last_day ?? '—')}）</td></tr>
      <tr><td>知识图谱人物索引序号</td><td class="num">${num(data.memory.graph)}</td></tr>
    </table>`
  document.dispatchEvent(new CustomEvent('synlove:overview', { detail: data }))
}

/**
 * 重启后**真实等待**服务起来：每 3 秒探一次，直到全部在线或超时。
 *
 * 以前是 `setTimeout(refresh, 60000)` 盲等——时间到了服务可能还没起（或者压根起失败了），
 * 面板上就一直是旧的/错的连通性，看着像摆设。现在用真实探测收敛。
 */
async function wait_until_up(timeout_ms = 240_000) {
  const started = Date.now()
  for (;;) {
    const seconds = Math.round((Date.now() - started) / 1000)
    try {
      const data = await get('/api/overview')
      const down = data.services.filter(service => !(service.available ?? service.up))
      if (down.length === 0) {
        $('service-hint').textContent = `重启完成，全部服务在线（用时 ${seconds} 秒）`
        return
      }
      $('service-hint').textContent = `重启中…已 ${seconds} 秒，等待：${down.map(item => item.name).join('、')}`
    } catch (error) {
      $('service-hint').textContent = `重启中…已 ${seconds} 秒（${error.message}）`
    }
    if (Date.now() - started > timeout_ms) {
      $('service-hint').textContent = `等了 ${seconds} 秒仍未全部在线，请查看「日志」里的 harness 运行日志`
      return
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
}

$('btn-restart').addEventListener('click', async () => {
  $('service-hint').textContent = '正在重启…'
  try {
    await post('/api/service', { action: 'restart' })
  } catch (error) {
    $('service-hint').textContent = `重启请求失败：${error.message}`
    return
  }
  await wait_until_up()
  await refresh_overview()
})
$('btn-stop').addEventListener('click', async () => {
  if (!confirm('确定停止后端服务？微信将不再回复。')) return
  await post('/api/service', { action: 'stop' })
  $('service-hint').textContent = '已请求停止'
  setTimeout(refresh_overview, 6000)
})

// ── 模型 ───────────────────────────────────────────────────────────────────

let models_cache = null

/** 无参数；显示故障转移开关与数量，候选模型和冷却原因按需展开。 */
async function refresh_failover() {
  try {
    const data = await get('/api/failover')
    const order = data.order ?? []
    const dead = data.dead ?? []
    $('failover-status').innerHTML = `
      <div class="failover-summary"><span class="badge ${data.enabled ? 'ok' : ''}">${data.enabled ? '已启用' : '已关闭'}</span><span>${order.length} 个候选</span>${dead.length ? `<span class="badge warn">${dead.length} 个冷却中</span>` : ''}</div>
      <details class="compact-details"><summary>候选顺序</summary><ol class="failover-order">${order.map(item => `<li>${escape_service(item)}</li>`).join('') || '<li>未配置</li>'}</ol>${dead.length ? `<div class="hint">${dead.map(item => `${escape_service(item.provider)}/${escape_service(item.model)} · ${escape_service(item.reason)} · ${escape_service(new Date(item.until).toLocaleTimeString())} 后重试`).join('<br>')}</div>` : ''}</details>`
  } catch (error) {
    $('failover-status').textContent = `读取失败：${error.message}`
  }
}

async function refresh_models() {
  const data = await get('/api/models')
  models_cache = data
  $('current-model').textContent = data.default?.provider
    ? `${data.default.provider} / ${data.default.model}`
    : '（未设置）'
  document.dispatchEvent(new CustomEvent('synlove:models', { detail: data }))

  $('provider-select').innerHTML = data.providers
    .map(provider => `<option value="${provider.id}">${provider.id}</option>`).join('')
  fill_models(data.default?.provider)
  $('provider-select').addEventListener('change', event => fill_models(event.target.value))

  $('model-table').innerHTML = `<table>
    <tr><th>provider</th><th>模型</th><th>能力</th><th>定价（元/M）</th></tr>
    ${data.providers.map(provider => provider.models.map(model => `
      <tr>
        <td>${provider.id}</td>
        <td>${model.name}</td>
        <td>${(model.input ?? []).join('+') || '—'}</td>
        <td>${price_text(model.pricing)}</td>
      </tr>`).join('')).join('')}
  </table>`
}

/** 定价的可读文案：免费 / 分档 / 单一价 / 无定价。 */
function price_text(pricing) {
  if (!pricing) return '—'
  if (pricing.free) return '<span class="up">免费</span>'
  if (Array.isArray(pricing.tiers)) {
    return pricing.tiers
      .map(tier => `≤${Math.round((tier.maxInputTokens ?? 0) / 1000)}k：入 ${tier.input} / 缓 ${tier.cacheRead} / 出 ${tier.output}`)
      .join('<br>')
  }
  return `入 ${pricing.input ?? '—'} / 缓 ${pricing.cacheRead ?? '—'} / 出 ${pricing.output ?? '—'}`
}

function fill_models(provider_id) {
  const provider = models_cache?.providers.find(item => item.id === provider_id)
  $('model-select').innerHTML = (provider?.models ?? [])
    .map(model => `<option value="${model.id}">${model.name}</option>`).join('')
}

$('btn-add-model').addEventListener('click', async () => {
  const payload = {
    provider: $('add-provider').value.trim(),
    baseURL: $('add-baseurl').value.trim(),
    apiKey: $('add-apikey').value.trim(),
    model: $('add-model').value.trim(),
    name: $('add-name').value.trim(),
    vision: $('add-vision').checked,
  }
  if (payload.provider === '' || payload.model === '') {
    $('add-hint').textContent = 'provider 名和模型 id 是必填的'
    return
  }
  try {
    const result = await post('/api/models/add', payload)
    $('add-hint').textContent = `${result.provider} / ${result.model} 已添加 —— ${result.note}`
    for (const id of ['add-apikey', 'add-model', 'add-name']) $(id).value = ''
    $('add-vision').checked = false
    refresh_models()
  } catch (error) {
    $('add-hint').textContent = `失败：${error.message}`
  }
})

$('btn-save-model').addEventListener('click', async () => {
  try {
    const result = await post('/api/models/default', {
      provider: $('provider-select').value,
      model: $('model-select').value,
    })
    $('model-hint').textContent = result.note
    refresh_models()
  } catch (error) {
    $('model-hint').textContent = `失败：${error.message}`
  }
})

// ── 开关 ───────────────────────────────────────────────────────────────────

async function refresh_toggles() {
  const data = await get('/api/toggles')
  const labels = {
    DSH_TIMELINE_ENABLED: '长期记忆',
    DSH_TIMELINE_IDLE_HOURS: '摘要更新等待（小时）',
    DSH_WIRE_ZH: '工具语言',
    DSH_MEMORY_CLOUD_MODEL: '云端模型',
    DSH_GEMMA_MIN_FREE_VRAM_MB: '最低空闲显存（MB）',
    DSH_GRAPH_CHUNK_CHARS: '图谱分块（字符）',
    DSH_WEIXIN_SEND_MIN_GAP_MS: '消息间隔（毫秒）',
  }
  $('toggles-immediate').innerHTML = data.immediate.map(item => `
    <div class="toggle">
      <label class="label">
        ${escape_service(item.label)} ${tool_help(item.help)}
      </label>
      <input type="checkbox" data-immediate="${item.key}" ${item.value ? 'checked' : ''} />
    </div>`).join('')

  $('toggles-restart').innerHTML = data.restart.map(item => {
    // 布尔参数用开启/关闭选项显示，提交时保持后端约定的字符串 1/0。
    const control = item.kind === 'bool'
      ? `<select class="setting-input" aria-label="${escape_service(labels[item.key] ?? item.label)}" data-restart="${item.key}"><option value="1" ${String(item.value) === '1' ? 'selected' : ''}>开启</option><option value="0" ${String(item.value) === '0' ? 'selected' : ''}>关闭</option></select>`
      : item.kind === 'select'
      ? `<select class="setting-input" data-restart="${item.key}">${(item.options ?? []).map(option =>
          `<option value="${escape_service(option.value)}" ${String(item.value) === option.value ? 'selected' : ''}>${escape_service(item.key === 'DSH_WIRE_ZH' ? (option.value === '0' ? '英文' : '中文') : option.label.split(/[（(]/)[0])}</option>`
        ).join('')}</select>`
      : `<input class="setting-input" ${item.kind === 'number' ? 'type="number"' : 'type="text"'} data-restart="${item.key}" value="${item.value}" />`
    return `
    <div class="toggle">
      <label class="label">
        ${escape_service(labels[item.key] ?? item.label)} ${tool_help(item.help)}
      </label>
      ${control}
    </div>`
  }).join('')

  for (const input of document.querySelectorAll('[data-immediate]')) {
    input.addEventListener('change', async () => {
      const result = await post('/api/toggles', {
        key: input.dataset.immediate, value: input.checked ? '1' : '0',
      })
      $('toggle-hint').textContent = result.note
    })
  }
  for (const input of document.querySelectorAll('[data-restart]')) {
    input.addEventListener('change', async () => {
      const result = await post('/api/toggles', { key: input.dataset.restart, value: input.value })
      $('toggle-hint').textContent = result.note
    })
  }
}

$('btn-restart-2').addEventListener('click', async () => {
  $('toggle-hint').textContent = '正在重启…'
  try {
    await post('/api/service', { action: 'restart' })
  } catch (error) {
    $('toggle-hint').textContent = `重启请求失败：${error.message}`
    return
  }
  await wait_until_up()
  $('toggle-hint').textContent = '重启完成，全部服务在线'
})

// ── 上下文长度与压缩 ───────────────────────────────────────────────────────

async function refresh_compaction() {
  let data
  try {
    data = await get('/api/compaction')
  } catch (error) {
    $('compaction-hint').textContent = `读取失败：${error.message}`
    return
  }
  const provider = data.model?.provider ?? ''
  const model = data.model?.model ?? ''
  $('ctx-model').textContent = model === '' ? '（未设置默认模型）' : `${model}（${provider}）`
  const models = await get('/api/models')
  const entry = (models.providers.find(item => item.id === provider)?.models ?? [])
    .find(item => item.id === model)
  $('ctx-window').value = entry?.contextWindow ?? 0
  $('ctx-budget').value = data.compressionBudget ?? 0
  $('ctx-retain').value = data.retainTokens ?? 0
  $('compaction-hint').textContent =
    `当前模型窗口 ${entry?.contextWindow ? num(entry.contextWindow) : '未设置（默认 262144）'} tokens`
}

$('btn-failover-refresh').addEventListener('click', () => refresh_failover())

$('btn-ctx-save').addEventListener('click', async () => {
  const models = await get('/api/models')
  const provider = models.default?.provider
  const model = models.default?.model
  try {
    const result = await post('/api/models/context-window', {
      provider, model, tokens: Number($('ctx-window').value),
    })
    $('compaction-hint').textContent = result.note
  } catch (error) {
    $('compaction-hint').textContent = `失败：${error.message}`
  }
})

$('btn-compaction-save').addEventListener('click', async () => {
  try {
    const result = await post('/api/compaction', {
      compressionBudget: Number($('ctx-budget').value),
      retainTokens: Number($('ctx-retain').value),
    })
    $('compaction-hint').textContent = result.note
    await post('/api/preset/reload', {}).catch(() => {})
    $('compaction-hint').textContent = `${result.note}；preset 已重载`
  } catch (error) {
    $('compaction-hint').textContent = `失败：${error.message}`
  }
})

// ── 人格与工具 ─────────────────────────────────────────────────────────────

async function refresh_persona() {
  const data = await get('/api/persona')
  $('persona-path').textContent = data.path
  $('persona-text').value = data.text
}

$('btn-reload-persona').addEventListener('click', () => { refresh_persona().catch(() => {}) })
$('btn-save-persona').addEventListener('click', async () => {
  try {
    const result = await post('/api/persona', { text: $('persona-text').value })
    $('persona-hint').textContent = result.note
    refresh_persona()
  } catch (error) {
    $('persona-hint').textContent = `失败：${error.message}`
  }
})

/** 参数 text：完整说明；生成自定义浮层的问号按钮，不使用系统原生 title 提示。 */
function tool_help(text) {
  const description = escape_service(text || '暂无说明')
  return `<button type="button" class="tool-help" aria-label="查看说明" data-help="${description}">?</button>`
}

/** 参数 tool：工具信息；名称后显示问号，保留简介及完整官方说明。 */
function tool_item(tool) {
  const description = [...new Set([tool.plain, tool.official].filter(Boolean))].join('\n\n')
  return `<li><code>${escape_service(tool.name)}</code>${tool_help(description)}</li>`
}

/** 一个插件包条目。 */
function tool_row(row) {
  const badge = row.mounted
    ? (row.disabled_reason ? `<span class="tag">${row.disabled_reason}</span>` : '<span class="tag ok">已挂载</span>')
    : '<span class="tag">未挂载</span>'
  const tools = (row.tools ?? []).length === 0
    ? ''
    : `<ul class="tool-list">${row.tools.map(tool_item).join('')}</ul>`
  // 分组里的子插件（例如 compaction 组里的 compaction-basic）
  const children = (row.children ?? []).length === 0 ? '' : `
    <ul class="tool-children">${row.children.map(item => `
      <li><code>${escape_service(item.id)}</code>
        ${item.disabled ? '<span class="tag">已禁用</span>' : ''}
      </li>`).join('')}</ul>`
  // 未挂载的：给出可直接粘贴的 preset 行（不直接替他改 preset——有些插件还要写配置）
  const mountable = row.mount_kind === 'ready'
  const companions = (row.companions ?? []).length === 0
    ? ''
    : `<div class="hint">依赖：${row.companions.map(item => escape_service(item.id)).join('、')}</div>`
  const preset_row = row.mounted === true || !row.preset_row ? '' : mountable
    ? `<div class="preset-row">
        <code>${escape_service(row.preset_row).replace(/\n/g, '<br>')}</code>
      </div>`
    : `<div class="preset-row">
        <span class="hint">不能一键挂载：${row.mount_reason ?? '原因未知'}</span>
      </div>`
  // 已挂载：勾选框切换"启用/禁用"；可挂的：勾选即挂载；其余：禁用并说明原因
  const toggle = row.mounted === true
    ? `<label class="checkbox"><input type="checkbox" data-tool="${row.id}" ${row.disabled ? '' : 'checked'} /> 启用</label>`
    : mountable
      ? `<label class="checkbox"><input type="checkbox" data-tool="${row.id}" data-mount="1" data-name="${row.name}" /> 挂载</label>`
      : '<span class="tag">不可一键挂载</span>'
  return `
    <div class="toggle tool-row${row.mounted === true ? '' : ' unmounted'}">
      <div class="label">
        <div class="tool-head">
          <strong>${escape_service(row.id)}</strong>${tool_help(row.summary)}
          ${badge}
        </div>
        ${(children || companions || tools || preset_row) ? `<details class="compact-details"><summary>详情${row.tools?.length ? ` · ${row.tools.length} 个工具` : ''}</summary>` : ''}
        ${children}
        ${companions}
        ${tools}
        ${preset_row}
        ${(children || companions || tools || preset_row) ? '</details>' : ''}
      </div>
      ${toggle}
    </div>`
}

async function refresh_tools() {
  const data = await get('/api/tools')
  $('tools-path').textContent = `${data.preset} · ${data.path}`
  if (data.rows.length === 0) {
    $('tools-list').innerHTML = '<span class="hint">没读到 preset 行</span>'
    return
  }
  const rows = data.rows
  const mounted = rows.filter(row => row.mounted === true && row.kind !== 'runtime')
  const runtime = rows.filter(row => row.kind === 'runtime')
  const available = rows.filter(row => row.mounted !== true)
  // 已挂载的排前面，然后运行期注册的，最后是"能挂但没挂"的
  const ordered = [...mounted, ...runtime, ...available]

  $('tools-hint').textContent = `${mounted.length} 个已挂载 · ${available.length} 个可添加`

  $('tools-list').innerHTML = ordered.map(tool_row).join('')
  for (const input of document.querySelectorAll('[data-tool]')) {
    input.addEventListener('change', async () => {
      const mounting = input.dataset.mount === '1'
      $('tools-hint').textContent = mounting
        ? `正在挂载 ${input.dataset.tool} 并验证 preset…（几秒）`
        : '正在写入 preset…'
      try {
        const result = mounting
          ? await post('/api/tools', { id: input.dataset.tool, name: input.dataset.name, mounted: true })
          : await post('/api/tools', { id: input.dataset.tool, disabled: !input.checked })
        $('tools-hint').textContent = result.note
        if (mounting) await refresh_tools()        // 挂载后重新渲染（变成"已挂载"那一组）
      } catch (error) {
        $('tools-hint').textContent = `失败：${error.message}`
        input.checked = !input.checked             // 失败时把开关拨回去，别骗用户
      }
    })
  }
}

// ── 微信绑定（扫码）─────────────────────────────────────────────────────────

const qr_state = { qrcode: null, refreshes: 0, timer: null }

function qr_stop(message) {
  if (qr_state.timer !== null) { clearTimeout(qr_state.timer); qr_state.timer = null }
  if (message !== undefined) $('qr-status').textContent = message
}

/** 取一张新二维码并开始轮询。 */
async function qr_start() {
  qr_stop('正在获取二维码…')
  try {
    const data = await post('/api/weixin/qr', {})
    qr_state.qrcode = data.qrcode
    qr_state.refreshes += 1
    $('qr-area').innerHTML = data.image
      ? `<img class="qr-img" src="${data.image}" alt="微信二维码" />`
      : `<p class="hint">二维码图片渲染失败（可能是当前 Python 缺少 qrcode 库）。可点下面的链接在手机上打开：</p>
         <p><a href="${data.content}" target="_blank" rel="noreferrer">${data.content}</a></p>`
    $('qr-status').textContent = `等待扫码…（第 ${qr_state.refreshes} 张）`
    qr_poll()
  } catch (error) {
    qr_stop(`获取二维码失败：${error.message}`)
  }
}

/** 轮询一次状态，按结果决定继续 / 停止 / 刷新二维码 / 提示去手机上确认。 */
function qr_poll() {
  qr_stop()
  qr_state.timer = setTimeout(async () => {
    if (qr_state.qrcode === null) return
    const query = `qrcode=${encodeURIComponent(qr_state.qrcode)}`
    let data
    try {
      data = await get(`/api/weixin/qr/status?${query}`)
    } catch (error) {
      qr_stop(`查询状态失败：${error.message}`)
      return
    }
    switch (data.status) {
      case 'wait':
        $('qr-status').textContent = `等待扫码…（第 ${qr_state.refreshes} 张）`
        qr_poll()
        return
      case 'scaned':
        $('qr-status').textContent = '已扫描，正在手机上验证…'
        qr_poll()
        return
      case 'need_verifycode':
        // 平台偶尔会要求"在手机上再确认一次"：不在界面里收数字（那个输入框实际没用上），
        // 只提示按手机提示完成，并继续轮询等待后续状态。
        $('qr-status').textContent = '按手机微信上的提示完成验证，界面会继续自动检测…'
        qr_poll()
        return
      case 'scaned_but_redirect':
        $('qr-status').textContent = `服务端要求切换接入点：${data.base ?? ''}`
        qr_poll()
        return
      case 'expired':
        if (qr_state.refreshes >= 3) { qr_stop('二维码多次失效，请点「获取二维码」重试'); return }
        $('qr-status').textContent = '二维码已过期，正在自动刷新…'
        qr_start()
        return
      case 'binded_redirect':
        qr_stop('这个微信号已经绑定过了，现有凭据仍然有效（无需重复连接）')
        return
      case 'verify_code_blocked':
        qr_stop('平台拒绝了这次验证，请稍后再试')
        return
      case 'confirmed':
        qr_stop(`绑定成功 ✅（bot_id ${data.bot_id}）${data.note ?? ''}`)
        // 新凭据要重启才生效，这里直接把"重启"按钮亮出来，省得用户再去翻服务状态页
        $('btn-qr-restart').disabled = false
        return
      default:
        $('qr-status').textContent = `状态：${data.status ?? '未知'}`
        qr_poll()
    }
  }, 2000)
}

$('btn-qr-start').addEventListener('click', () => {
  qr_state.refreshes = 0
  $('btn-qr-restart').disabled = true
  qr_start()
})
$('btn-qr-stop').addEventListener('click', () => qr_stop('已停止轮询'))
$('btn-qr-restart').addEventListener('click', async () => {
  $('qr-status').textContent = '正在重启后端服务…（约需 1~2 分钟）'
  try {
    const result = await post('/api/service', { action: 'restart' })
    $('qr-status').textContent = `已提交重启：${result.message ?? JSON.stringify(result)}`
  } catch (error) {
    $('qr-status').textContent = `重启失败：${error.message}`
  }
})
// ── 记忆维护（清空时间记忆库 / 上下文 / 知识图谱）───────────────────────────

/** 人类可读的字节数。 */
function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** 相对时间（几分钟前）。 */
function ago(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/**
 * 危险操作按钮：点一次变成"确认清空"，再点一次才真执行。
 * 没有用浏览器 confirm()：它会被误触，而且样式骗不了人。
 */
function danger_button(label, target, hint) {
  const button = document.createElement('button')
  button.className = 'danger'
  button.textContent = label
  let armed = false
  const disarm = () => {
    armed = false
    button.classList.remove('armed')
    button.textContent = label
  }
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true
      button.classList.add('armed')
      button.textContent = '真的要清空？再点一次确认'
      setTimeout(disarm, 6000)
      return
    }
    disarm()
    button.disabled = true
    $('memory-status').textContent = `正在清空${hint}…`
    try {
      const result = await post('/api/memory/clear', { target })
      $('memory-status').textContent = `已清空${hint}${result.note ? `（${result.note}）` : ''}`
    } catch (error) {
      $('memory-status').textContent = `清空${hint}失败：${error.message}`
    }
    button.disabled = false
    await load_memory(true)
  })
  return button
}

/** 渲染一张记忆卡片：标题 + 体量/内容 + 二次确认的清空按钮。 */
function memory_card({ title, detail, target, multiline }) {
  const card = document.createElement('div')
  card.className = 'memory-card'
  const head = document.createElement('div')
  head.className = 'name'
  head.textContent = title
  const text = document.createElement('div')
  text.className = 'hint'
  text.textContent = detail
  if (multiline === true) text.style.whiteSpace = 'pre-line'
  card.append(head, text, danger_button(`清空${title}`, target, title))
  return card
}

async function load_memory(quiet) {
  if (!quiet) $('memory-status').textContent = '正在读取…'
  let data
  try {
    data = await get('/api/memory/stats')
  } catch (error) {
    $('memory-status').textContent = `读取失败：${error.message}`
    $('memory-cards').innerHTML = ''
    return
  }
  $('memory-status').textContent = `读取于 ${new Date().toLocaleTimeString()}`

  // 队列体量在 overview 里（按状态分组），顺手拿一下
  let outbox_rows = []
  try {
    outbox_rows = (await get('/api/overview')).outbox ?? []
  } catch { /* 后端没起来时只显示"读取失败" */ }
  const queue_total = outbox_rows
    .filter(row => row.status !== 'sent' && row.status !== 'failed_terminal')
    .reduce((sum, row) => sum + row.n, 0)

  const timeline = data.timeline ?? {}
  const graph = data.graph ?? {}
  const users = data.context?.users ?? []
  const cards = [
    {
      title: '时间记忆库',
      target: 'timeline',
      detail: timeline.error ?? `${timeline.days ?? 0} 天 · ${timeline.entries ?? 0} 条记录 · ${human(timeline.bytes)}`,
    },
    {
      title: '对话上下文',
      target: 'context',
      multiline: true,
      detail: users.length === 0
        ? '暂无会话'
        : users.map(user => `${user.user_id}\n　第 ${user.epoch + 1} 段会话 · ${human(user.bytes)} · ${ago(user.modified_at)}${user.online ? ' · 在线' : ''}`).join('\n'),
    },
    {
      title: '出站队列',
      target: 'queue',
      detail: queue_total === 0
        ? '队列为空'
        : `待发/停放 ${queue_total} 条　`
          + outbox_rows.filter(row => row.status !== 'sent' && row.status !== 'failed_terminal')
            .map(row => `${row.status}(${row.kind}) ${row.n}`).join('　'),
    },
    {
      title: '知识图谱',
      target: 'graph',
      detail: graph.error ?? `${graph.people ?? 0} 个人物 · ${graph.relations ?? 0} 条称呼 · ${human(graph.bytes)}`,
    },
  ]
  $('memory-cards').innerHTML = ''
  for (const item of cards) $('memory-cards').append(memory_card(item))
}

$('btn-memory-refresh').addEventListener('click', () => load_memory(false))

// ── Token 用量 ─────────────────────────────────────────────────────────────

async function refresh_usage() {
  const data = await get(`/api/usage?days=${$('usage-days').value}`)
  const total = data.total ?? {}
  $('usage-cards').innerHTML = `
    <div class="service"><div class="name">调用次数</div><div class="value">${num(total.calls)}</div></div>
    <div class="service"><div class="name">输入 token</div><div class="value">${num(total.input)}</div></div>
    <div class="service"><div class="name">缓存命中</div><div class="value">${num(total.cacheRead)}</div></div>
    <div class="service"><div class="name">输出 token</div><div class="value">${num(total.output)}</div></div>
    <div class="service"><div class="name">合计 token</div><div class="value">${num(total.totalTokens)}</div></div>
    <div class="service"><div class="name">估算成本</div><div class="value">${money(total.cost)}</div></div>`

  const table = (rows, first) => `<table>
    <tr><th>${first}</th><th class="num">调用</th><th class="num">输入</th><th class="num">缓存</th>
    <th class="num">输出</th><th class="num">合计</th><th class="num">成本</th></tr>
    ${rows.map(row => `<tr>
      <td>${row.date ?? row.model}${row.priced === false ? '（无定价）' : ''}</td>
      <td class="num">${num(row.calls)}</td><td class="num">${num(row.input)}</td>
      <td class="num">${num(row.cacheRead)}</td><td class="num">${num(row.output)}</td>
      <td class="num">${num(row.totalTokens)}</td><td class="num">${money(row.cost)}</td></tr>`).join('')}
  </table>`

  $('usage-days-table').innerHTML = data.days.length === 0 ? '<span class="hint">这段时间没有调用记录</span>' : table(data.days, '日期')
  $('usage-model-table').innerHTML = data.by_model.length === 0 ? '<span class="hint">—</span>' : table(data.by_model, '模型')
}

$('btn-refresh-usage').addEventListener('click', refresh_usage)
$('usage-days').addEventListener('change', refresh_usage)

// ── 日志 ───────────────────────────────────────────────────────────────────

let log_timer = null

async function refresh_log() {
  const name = $('log-select').value || 'probe'
  const data = await get(`/api/logs?name=${name}&lines=400`)
  const filter = $('log-filter').value.trim()
  let lines = data.text.split('\n')
  if (filter) lines = lines.filter(line => line.includes(filter))
  $('log-hint').textContent = `${data.name} · ${data.exists ? '' : '文件不存在 · '}显示 ${lines.length} 行`
  $('log-view').innerHTML = lines
    .map(line => line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/error/gi, '<span class="err">error</span>')
      .replace(/warn/gi, '<span class="warn">warn</span>'))
    .join('\n')
  $('log-view').scrollTop = $('log-view').scrollHeight
}

function setup_log_select() {
  $('log-select').innerHTML = [
    ['probe', '微信链路探针'], ['llm', '模型请求（含 token 用量）'],
    ['harness', 'harness 运行日志'], ['opencode', 'opencode server'],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('')
}

$('btn-refresh-log').addEventListener('click', refresh_log)
$('log-select').addEventListener('change', refresh_log)
$('log-filter').addEventListener('input', refresh_log)
setInterval(() => {
  if ($('log-follow').checked && $('tab-logs').classList.contains('active') && !document.hidden) {
    refresh_log().catch(error => { $('log-hint').textContent = `读取失败：${error.message}` })
  }
}, 3000)

// ── 后端守护（心跳） ───────────────────────────────────────────────────────

/**
 * 渲染守护卡片：状态徽标、参数、说明与最近日志。
 * 参数输入框只在"没被聚焦"时回填，免得你正在改数字时被刷新覆盖。
 */
function render_heartbeat(data) {
  const badge = $('hb-badge')
  const live = data.probe_results.filter(item => item.up).length
  if (data.restarting) {
    badge.textContent = '正在自动重启'; badge.className = 'badge warn'
  } else if (data.paused) {
    badge.textContent = '已暂停'; badge.className = 'badge warn'
  } else if (data.consecutive_fails === 0 && live > 0) {
    badge.textContent = '在线'; badge.className = 'badge ok'
  } else {
    badge.textContent = `掉线 ×${data.consecutive_fails}`; badge.className = 'badge bad'
  }

  const stamp = ms => (ms ? new Date(ms).toLocaleTimeString('zh-CN') : '—')
  $('hb-detail').textContent = `${data.detail}　｜　最近探活 ${stamp(data.last_probe_at)}（来源 ${data.last_source || '—'}）`
    + `　｜　最近恢复 ${stamp(data.last_ok_at)}　｜　最近重启 ${stamp(data.last_restart_at)}　${data.last_restart_result}`

  const note = []
  if (!data.config.enabled) note.push('自动重启已关闭（只探活）')
  if (data.paused) note.push(`已暂停自动重启：${data.paused_reason}（点"恢复自动重启"解除）`)
  note.push(`本小时已自动重启 ${data.restart_history.filter(t => t >= Date.now() - 3600000).length} 次（上限 ${data.config.max_restarts_per_hour}）`)
  note.push(`前端心跳 ${data.page_pings} 次`)
  $('hb-note').textContent = note.join('　｜　')

  if (document.activeElement !== $('hb-interval')) $('hb-interval').value = Math.round(data.config.interval_ms / 1000)
  if (document.activeElement !== $('hb-threshold')) $('hb-threshold').value = data.config.fail_threshold
  if (document.activeElement !== $('hb-cooldown')) $('hb-cooldown').value = Math.round(data.config.cooldown_ms / 60000)
  if (document.activeElement !== $('hb-max')) $('hb-max').value = data.config.max_restarts_per_hour
  $('hb-enabled').checked = data.config.enabled === true
  $('hb-resume').classList.toggle('hb-hidden', !data.paused)

  $('hb-log').textContent = (data.recent ?? []).join('\n')
  $('hb-log').scrollTop = $('hb-log').scrollHeight
}

/** 拉一次守护状态。 */
async function refresh_heartbeat() {
  render_heartbeat(await get('/api/heartbeat'))
}

$('hb-save').addEventListener('click', async () => {
  try {
    const data = await post('/api/heartbeat', {
      enabled: $('hb-enabled').checked,
      interval_ms: Number($('hb-interval').value) * 1000,
      fail_threshold: Number($('hb-threshold').value),
      cooldown_ms: Number($('hb-cooldown').value) * 60_000,
      max_restarts_per_hour: Number($('hb-max').value),
    })
    render_heartbeat(data)
    $('hb-note').textContent = '已保存：' + $('hb-note').textContent
  } catch (error) {
    $('hb-note').textContent = `保存失败：${error.message}`
  }
})

$('hb-check').addEventListener('click', async () => {
  $('hb-detail').textContent = '正在探活…'
  try {
    render_heartbeat(await post('/api/heartbeat/check'))
  } catch (error) {
    $('hb-detail').textContent = `探活失败：${error.message}`
  }
})

$('hb-resume').addEventListener('click', async () => {
  render_heartbeat(await post('/api/heartbeat/resume'))
})

// ── Backend Service ──────────────────────────────────────────────────────

/** 渲染公共后台服务配置及身份协议探测结果。 */
function render_backend(data) {
  const config = data.config ?? data
  $('backend-mode').value = config.mode === 'remote' ? 'remote' : 'local'
  $('backend-host').value = config.host ?? '127.0.0.1'
  $('backend-radius').value = config.scanRadius ?? 12
  const rows = data.services ?? Object.entries(config.services ?? {}).map(([name, spec]) => ({
    name, label: spec.label ?? name.toUpperCase(), port: config.resolved?.[name]?.port,
    available: Boolean(config.resolved?.[name]), detail: config.resolved?.[name] ? '已记录上次通过协议的端口' : '尚未查验',
  }))
  $('backend-services').innerHTML = rows.map(item => `
    <div class="backend-service-row">
      <span class="service-dot ${item.available ? 'is-up' : 'is-down'}" aria-label="${item.available ? '可用' : '未就绪'}"></span>
      <strong>${escape_service(item.label)}</strong>
      <span class="backend-service-port">${item.port ? `端口 ${item.port}` : '未找到'}</span>
      <span class="hint">${escape_service(item.detail ?? '')}</span>
    </div>`).join('') || '<span class="hint">还没有公共服务配置</span>'
}

/** 读取配置；页面打开时不自动扫描，避免频繁触碰远程端口。 */
async function refresh_backend_config() {
  render_backend(await get('/api/backend'))
}

$('backend-save').addEventListener('click', async () => {
  const hint = $('backend-hint')
  hint.textContent = '正在保存…'
  try {
    const result = await post('/api/backend/config', {
      mode: $('backend-mode').value,
      host: $('backend-host').value.trim(),
      scanRadius: Number($('backend-radius').value),
    })
    render_backend(result)
    hint.textContent = result.restartRequired ? '已保存；重启后端后新地址才会用于业务调用' : '已保存'
  } catch (error) {
    hint.textContent = `保存失败：${error.message}`
  }
})

$('backend-probe').addEventListener('click', async () => {
  const hint = $('backend-hint')
  hint.textContent = '正在按递推规则查验端口…'
  try {
    render_backend(await post('/api/backend/probe', {
      mode: $('backend-mode').value,
      host: $('backend-host').value.trim(),
      scanRadius: Number($('backend-radius').value),
    }))
    hint.textContent = '查验完成：只有通过 SynLove 身份协议的端口才会亮绿灯'
  } catch (error) {
    hint.textContent = `查验失败：${error.message}`
  }
})

/**
 * 前端心跳：页面开着时每 30 秒给控制台发一次。
 * 控制台收到后会按节流触发一次真探活；页面关掉也照样有定时器兜底。
 */
setInterval(() => { post('/api/heartbeat/ping').catch(() => {}) }, 30_000)
setInterval(() => { refresh_heartbeat().catch(() => {}) }, 5_000)

// ── QQ 通道 ───────────────────────────────────────────────────────────────

/**
 * 刷新 QQ 通道：状态徽标 + 机器人信息 + 扫码二维码。
 * 二维码内容是官方 /users/@me 返回的 share_url（手机 QQ 扫码即可添加/打开机器人）。
 */
async function refresh_qq() {
  const badge = $('qq-badge')
  const data = await get('/api/qq/qr')
  if (data.configured === false) {
    badge.textContent = '未配置'; badge.className = 'badge warn'
    $('qq-status').textContent = data.note || '还没填凭据'
    $('qq-qr-area').innerHTML = ''
    return
  }
  if (data.error !== undefined) {
    badge.textContent = '异常'; badge.className = 'badge bad'
    $('qq-status').textContent = `凭据有问题：${data.error}`
    $('qq-qr-area').innerHTML = ''
    return
  }
  badge.textContent = '已连接'; badge.className = 'badge ok'
  $('qq-name').textContent = data.bot?.username ?? '—'
  $('qq-appid').textContent = data.appId ?? '—'
  $('qq-status').textContent = '扫码添加'
  $('qq-app-id').value = data.appId ?? ''
  $('qq-qr-area').innerHTML = data.png === ''
    ? '<span class="hint">（官方没返回分享链接，无法生成二维码）</span>'
    : `<img alt="QQ 机器人二维码" src="${data.png}" />`
}

$('btn-qq-refresh').addEventListener('click', () => { refresh_qq().catch(error => { $('qq-status').textContent = `刷新失败：${error.message}` }) })
$('btn-qq-check').addEventListener('click', () => { refresh_qq().catch(error => { $('qq-status').textContent = `检查失败：${error.message}` }) })
$('btn-qq-save').addEventListener('click', async () => {
  const appId = $('qq-app-id').value.trim()
  const clientSecret = $('qq-app-secret').value.trim()
  try {
    const result = await post('/api/qq', { appId, clientSecret })
    $('qq-save-note').textContent = result.note ?? '已保存'
    $('qq-app-secret').value = ''
  } catch (error) {
    $('qq-save-note').textContent = `保存失败：${error.message}`
  }
})

// ── 启动 ───────────────────────────────────────────────────────────────────

setup_log_select()
// 等待全部页面模块注册事件后再加载概览，避免本机快速响应早于概览监听器就绪。
document.addEventListener('DOMContentLoaded', () => {
  refresh_overview().catch(error => {
    $('status-strip').textContent = `读取失败：${error.message}`
    document.dispatchEvent(new CustomEvent('synlove:overview-error', { detail: error.message }))
  })
  refresh_models().catch(() => {})
  refresh_backend_config().catch(error => {
    $('backend-hint').textContent = `读取后台配置失败：${error.message}`
  })
})
refresh_toggles().catch(() => {})
refresh_heartbeat().catch(() => {})
setInterval(() => refresh_overview().catch(error => {
  $('status-strip').textContent = `读取失败：${error.message}`
  document.dispatchEvent(new CustomEvent('synlove:overview-error', { detail: error.message }))
}), 15000)
