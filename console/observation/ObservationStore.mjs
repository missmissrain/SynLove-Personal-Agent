/**
 * 观测查询层：读取有界 JSONL 副本，保存独立人工评分，聚合调用树和趋势。
 * 注册参数 runtime/config：运行目录和配置目录；secret：按环境变量名读取凭据的回调。
 * 默认不访问远端；SQLite 只存观测副本、游标和评分，不读取或写入消息业务状态。
 */
import { open, readdir, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ID = /^[a-f0-9]{32}$/
const SPAN = /^[a-f0-9]{16}$/
const DEFAULTS = {
  maxReadBytes: 33_554_432, maxRecords: 50_000, trendDays: 7,
  minimumSamples: 20, errorRateWarning: 0.1, toolErrorRateWarning: 0.15,
  scoreWarning: 3, minimumScores: 5, retainedFiles: 4,
  errorRateIncreaseWarning: 0.05, latencyRatioWarning: 1.5, costRatioWarning: 1.5,
}

export class ObservationStore {
  /** 参数 runtime/config：目录；secret：服务端凭据解析器，不向浏览器返回密钥。 */
  constructor({ runtime, config, secret = name => process.env[name] }) {
    this.runtime = runtime
    this.config = config
    this.secret = secret
    this.db = undefined
    this.cache = undefined
    this.loading = undefined
    this.remote = { state: 'disabled', note: '远端观测未启用' }
    this.syncing = undefined
    this.lastSync = 0
  }

  /** 无参数；读取显示阈值与资源上限，非法配置不放大读取范围。 */
  settings() {
    let input = {}
    try {
      const parsed = JSON.parse(readFileSync(join(this.config, 'observationConfig.json'), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed
    } catch { /* 可选配置使用默认值。 */ }
    const cfg = { ...DEFAULTS, relay: input.relay && typeof input.relay === 'object' ? input.relay : {} }
    for (const key of Object.keys(DEFAULTS)) {
      const val = Number(input[key])
      if (Number.isFinite(val) && val > 0) {
        const bounded = Math.min(val, key.includes('Rate') ? 1 : key === 'maxReadBytes' ? 67_108_864 : key === 'maxRecords' ? 100_000 : key === 'retainedFiles' ? 16 : 365)
        cfg[key] = key.includes('Rate') || key.includes('Ratio') ? bounded : Math.max(1, Math.trunc(bounded))
      }
    }
    return cfg
  }

  /** 无参数；惰性建立单独的观测 SQLite，评分以 trace/span 唯一键更新。 */
  async database() {
    if (this.db) return this.db
    await mkdir(this.runtime, { recursive: true })
    // mkdir await 后再次检查，避免并发首个请求重复打开连接。
    if (this.db) return this.db
    this.db = new DatabaseSync(join(this.runtime, 'observations.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS scores (
        traceId TEXT NOT NULL, spanId TEXT NOT NULL, score INTEGER NOT NULL,
        note TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (traceId, spanId)
      );
      CREATE TABLE IF NOT EXISTS relayEvents (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    return this.db
  }

  /** 参数 record：本地或远端 JSON；返回严格白名单投影，拒绝无效关联字段。 */
  normalize(record) {
    if (!record || !ID.test(record.traceId ?? '') || /^0+$/.test(record.traceId) || !Number.isFinite(Date.parse(record.at))) return undefined
    if (!['turn', 'model', 'tool', 'transport', 'relay', 'node'].includes(record.kind)) return undefined
    if (!['start', 'end', 'event'].includes(record.phase)) return undefined
    const out = { traceId: record.traceId, kind: record.kind, phase: record.phase, at: record.at }
    for (const key of ['spanId', 'parentSpanId']) if (SPAN.test(record[key] ?? '')) out[key] = record[key]
    for (const key of ['sessionId', 'name', 'model', 'provider', 'purpose', 'taskId', 'event', 'eventId', 'source', 'deliveryId', 'outboxId', 'outcome']) {
      if (typeof record[key] === 'string') out[key] = record[key].slice(0, 200)
    }
    for (const key of ['promptVersion', 'toolsVersion', 'personaVersion']) if (/^[a-f0-9]{64}$/.test(record[key] ?? '')) out[key] = record[key]
    for (const key of ['turn', 'step', 'durationMs', 'ttftMs', 'attempts', 'generation', 'droppedEvents']) {
      if (typeof record[key] === 'number' && Number.isFinite(record[key]) && record[key] >= 0) out[key] = record[key]
    }
    if (['ok', 'error', 'cancelled', 'incomplete'].includes(record.status)) out.status = record.status
    if (record.usage && typeof record.usage === 'object') {
      out.usage = {}
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
        if (Number.isFinite(record.usage[key]) && record.usage[key] >= 0) out.usage[key] = record.usage[key]
      }
    }
    return out
  }

  /** 无参数；按配置读取 VPS 有界缓存，失败只标注缺口，旧 Hub 的 404 不影响本地查询。 */
  async sync_remote() {
    if (this.syncing) return this.syncing
    if (Date.now() - this.lastSync < 5000) return
    this.lastSync = Date.now()
    this.syncing = this.fetch_remote().finally(() => { this.syncing = undefined })
    return this.syncing
  }

  /** 无参数；只访问管理员配置的地址，最多接收 4MiB 元数据，持久化去重游标。 */
  async fetch_remote() {
    const cfg = this.settings().relay
    if (cfg.enabled !== true) { this.remote = { state: 'disabled', note: '远端观测未启用' }; return }
    try {
      const base = new URL(cfg.baseURL)
      if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('远端地址格式不正确')
      const key = this.secret(String(cfg.apiKeyEnv ?? 'RELAY_TOKEN'))
      if (!key) throw new Error('远端观测凭据未配置')
      const db = await this.database()
      const cursorKey = `relay:${base.origin}${base.pathname}`
      const cursor = db.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey)?.value ?? ''
      const url = new URL(`${base.href.replace(/\/$/, '')}/observations`)
      url.searchParams.set('after', cursor)
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
        signal: AbortSignal.timeout(Math.max(500, Math.min(Number(cfg.timeoutMs) || 2500, 10_000))),
      })
      if (!response.ok) throw new Error(`远端观测 HTTP ${response.status}`)
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 4_194_304) throw new Error('远端观测数据超出上限')
          chunks.push(Buffer.from(value))
        }
      } finally { await reader.cancel().catch(() => {}) }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!Array.isArray(payload.events) || payload.events.length > 4096 || typeof payload.cursor !== 'string' || payload.cursor.length > 100) throw new Error('远端观测响应格式不正确')
      db.exec('BEGIN IMMEDIATE')
      try {
        const insert = db.prepare('INSERT OR IGNORE INTO relayEvents(id,body) VALUES (?,?)')
        for (const item of payload.events) {
          const row = this.normalize(item)
          if (row?.eventId) insert.run(row.eventId, JSON.stringify(row))
        }
        db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(cursorKey, payload.cursor)
        if (payload.gap) db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(`${cursorKey}:gap`, '1')
        db.prepare('DELETE FROM relayEvents WHERE rowid NOT IN (SELECT rowid FROM relayEvents ORDER BY rowid DESC LIMIT ?)').run(this.settings().maxRecords)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      const gap = Boolean(payload.gap) || this.remote.gap === true || db.prepare('SELECT value FROM meta WHERE key=?').get(`${cursorKey}:gap`)?.value === '1'
      this.remote = { state: 'ok', gap, note: gap ? '已连接；曾出现远端缓存缺口，历史可能不完整' : '已连接', lastAt: new Date().toISOString() }
      this.cache = undefined
    } catch (error) {
      this.remote = { state: 'error', gap: this.remote.gap, note: error instanceof Error ? error.message : '远端观测不可用' }
    }
  }

  /** 无参数；缓存 2 秒并合并并发读取，最多读取配置字节数和事件数。 */
  async snapshot() {
    if (this.loading) return this.loading
    if (this.cache && Date.now() - this.cache.loadedAt < 2000) return this.cache
    this.loading = this.load_snapshot().finally(() => { this.loading = undefined })
    return this.loading
  }

  /** 无参数；读取轮转日志尾部，显式返回截断、坏行与丢弃计数。 */
  async load_snapshot() {
    const cfg = this.settings()
    const records = []
    let budget = cfg.maxReadBytes
    let malformed = 0
    let truncated = false
    let droppedEvents = 0
    const files = (await readdir(this.runtime).catch(() => []))
      .filter(name => /^observations\.jsonl(?:\.[1-9][0-9]*)?$/.test(name))
      .sort((a, b) => (Number(a.split('.').at(-1)) || 0) - (Number(b.split('.').at(-1)) || 0))
    for (const name of files.slice(0, cfg.retainedFiles)) {
      if (budget <= 0 || records.length >= cfg.maxRecords) { truncated = true; break }
      let file
      try {
        file = await open(join(this.runtime, name), 'r')
        const size = (await file.stat()).size
        const bytes = Math.min(size, budget)
        budget -= bytes
        const buffer = Buffer.alloc(bytes)
        const { bytesRead } = await file.read(buffer, 0, bytes, size - bytes)
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
        if (size > bytes) { lines.shift(); truncated = true }
        // 最后一行未完成时等待下一次读取，不将并发追加误报成坏行。
        if (lines.at(-1) !== '') lines.pop()
        for (const line of lines.reverse()) {
          if (!line.trim()) continue
          if (records.length >= cfg.maxRecords) { truncated = true; break }
          try {
            const row = this.normalize(JSON.parse(line))
            if (row) { records.push(row); droppedEvents = Math.max(droppedEvents, row.droppedEvents ?? 0) }
            else malformed++
          } catch { malformed++ }
        }
      } catch { truncated = true } finally { await file?.close() }
    }
    // 历史副本只承载旧探针中可核实的元数据，与原生采集独立保存。
    let historical = 0
    try {
      const file = await open(join(this.runtime, 'observations.history.jsonl'), 'r')
      try {
        const size = (await file.stat()).size
        if (size > budget) truncated = true
        else {
          const text = await file.readFile('utf8')
          const native = new Set(records.filter(row => row.kind === 'model' && row.phase === 'end').map(row => `${row.at}:${row.model}`))
          for (const line of text.split('\n').reverse()) {
            if (!line.trim()) continue
            if (records.length >= cfg.maxRecords) { truncated = true; break }
            try {
              const row = this.normalize(JSON.parse(line))
              if (!row) { malformed++; continue }
              if (native.has(`${row.at}:${row.model}`)) continue
              records.push(row)
              historical++
            } catch { malformed++ }
          }
        }
      } finally { await file.close() }
    } catch (error) { if (error.code !== 'ENOENT') truncated = true }
    const db = await this.database()
    for (const row of db.prepare('SELECT body FROM relayEvents ORDER BY rowid DESC LIMIT ?').all(cfg.maxRecords)) {
      const item = this.normalize(JSON.parse(row.body))
      if (item) records.push(item)
    }
    if (records.length > cfg.maxRecords) {
      records.sort((a, b) => b.at.localeCompare(a.at))
      records.length = cfg.maxRecords
      truncated = true
    }
    const scores = db.prepare('SELECT * FROM scores ORDER BY updatedAt DESC LIMIT ?').all(cfg.maxRecords)
    this.cache = { loadedAt: Date.now(), records, scores, health: { malformed, truncated, droppedEvents, historical, remote: this.remote } }
    return this.cache
  }

  /** 参数 query：关键词、状态、模型、天数、页码；返回有界调用链列表。 */
  async list(query = {}) {
    const snapshot = await this.snapshot()
    const days = Math.max(1, Math.min(30, Number(query.days) || 7))
    const since = Date.now() - days * 86_400_000
    const traces = new Map()
    for (const row of snapshot.records) {
      if (Date.parse(row.at) < since) continue
      const trace = traces.get(row.traceId) ?? {
        traceId: row.traceId, sessionId: row.sessionId, startedAt: row.at, lastAt: row.at,
        status: 'incomplete', models: new Set(), promptVersions: new Set(), modelCalls: 0, toolCalls: 0,
        errors: 0, durationMs: undefined, hasRoot: false, closed: false,
      }
      trace.startedAt = trace.startedAt < row.at ? trace.startedAt : row.at
      trace.lastAt = trace.lastAt > row.at ? trace.lastAt : row.at
      trace.sessionId ||= row.sessionId
      if (row.model) trace.models.add(row.model)
      if (row.promptVersion) trace.promptVersions.add(row.promptVersion)
      if (row.personaVersion) trace.promptVersions.add(row.personaVersion)
      if (row.phase === 'end' && row.kind === 'model') trace.modelCalls++
      if (row.phase === 'end' && row.kind === 'tool') trace.toolCalls++
      if (row.phase === 'end' && row.status === 'error') trace.errors++
      if (row.kind === 'turn') {
        trace.hasRoot = true
        if (row.phase === 'start') { trace.rootStartAt = row.at; if (!trace.closed) trace.status = 'incomplete' }
        if (row.phase === 'end') { trace.status = row.status; trace.closed = true; trace.rootEndAt = row.at }
      }
      if (!trace.hasRoot && row.kind === 'model' && row.phase === 'end') { trace.status = row.status; trace.modelDurationMs = row.durationMs }
      traces.set(row.traceId, trace)
    }
    const q = String(query.q ?? '').toLowerCase().slice(0, 200)
    const items = [...traces.values()].map(item => ({
      ...item, models: [...item.models], promptVersions: [...item.promptVersions],
      durationMs: item.rootStartAt && item.rootEndAt ? Math.max(0, Date.parse(item.rootEndAt) - Date.parse(item.rootStartAt)) : item.hasRoot ? undefined : item.modelDurationMs,
    })).filter(item => (!query.status || item.status === query.status)
      && (!query.model || item.models.includes(query.model))
      && (!q || `${item.traceId} ${item.sessionId ?? ''} ${item.models.join(' ')} ${item.promptVersions.join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    const page = Math.max(1, Math.min(10000, Math.trunc(Number(query.page) || 1)))
    return { items: items.slice((page - 1) * 50, page * 50), total: items.length, page, health: snapshot.health }
  }

  /** 参数 trace_id：合法 trace ID；返回调用树所需的 spans 与独立事件。 */
  async detail(trace_id) {
    if (!ID.test(trace_id)) throw new Error('调用链 ID 格式不正确')
    const { records, scores, health } = await this.snapshot()
    const events = records.filter(row => row.traceId === trace_id).sort((a, b) => a.at.localeCompare(b.at))
    const spans = new Map()
    for (const row of events) {
      if (!row.spanId || row.phase === 'event') continue
      const span = spans.get(row.spanId) ?? { spanId: row.spanId, status: 'incomplete' }
      if (row.phase === 'start') Object.assign(span, row, { startedAt: row.at, status: span.status })
      else Object.assign(span, row, { endedAt: row.at })
      spans.set(row.spanId, span)
    }
    for (const span of spans.values()) {
      if (span.startedAt && span.endedAt && span.durationMs === undefined) span.durationMs = Date.parse(span.endedAt) - Date.parse(span.startedAt)
      span.partial = !span.startedAt || !span.endedAt
      span.score = scores.find(item => item.traceId === trace_id && item.spanId === span.spanId)
    }
    return { traceId: trace_id, spans: [...spans.values()].slice(0, 1000), truncatedSpans: spans.size > 1000, events: events.filter(row => row.phase === 'event').slice(-300), health }
  }

  /** 参数 body：模型 span、1–5 分与可选备注；仅对存在的模型执行记录更新评分。 */
  async set_score(body) {
    if (!ID.test(body.traceId ?? '') || !SPAN.test(body.spanId ?? '') || !Number.isInteger(body.score) || body.score < 1 || body.score > 5) throw new Error('评分需要有效调用标识及 1–5 的整数')
    if (typeof body.note !== 'string' || body.note.length > 500) throw new Error('评分备注最多 500 字')
    const detail = await this.detail(body.traceId)
    if (!detail.spans.some(span => span.kind === 'model' && span.spanId === body.spanId && span.endedAt)) throw new Error('找不到已结束的模型调用，不能评分')
    const db = await this.database()
    db.prepare('INSERT OR REPLACE INTO scores(traceId,spanId,score,note,updatedAt) VALUES (?,?,?,?,?)')
      .run(body.traceId, body.spanId, body.score, body.note, new Date().toISOString())
    this.cache = undefined
    return { ok: true }
  }

  /** 参数 days：统计天数；分别聚合执行错误、工具失败、版本表现与人工评分。 */
  async trends(days = 7) {
    const cfg = this.settings()
    const snapshot = await this.snapshot()
    const count = Math.max(1, Math.min(30, Number(days) || cfg.trendDays))
    const since = Date.now() - count * 86_400_000
    const scores = new Map(snapshot.scores.map(row => [`${row.traceId}:${row.spanId}`, row.score]))
    const groups = new Map()
    const daily = new Map()
    let pricing = {}
    try { pricing = JSON.parse(readFileSync(join(this.config, 'modelConfig.json'), 'utf8')).providers ?? {} } catch { /* 未配置价格时明确标注未估价。 */ }
    const summarize = rows => {
      const model = rows.filter(row => row.kind === 'model')
      const tools = rows.filter(row => row.kind === 'tool')
      const ms = model.map(row => row.durationMs).filter(Number.isFinite).sort((a, b) => a - b)
      const rated = model.map(row => scores.get(`${row.traceId}:${row.spanId}`)).filter(Number.isFinite)
      const errorCount = model.filter(row => row.status === 'error').length
      const costs = {}
      let unpricedCalls = 0
      for (const row of model) {
        const estimate = this.estimate_cost(row, pricing)
        if (!estimate) unpricedCalls++
        else costs[estimate.currency] = (costs[estimate.currency] ?? 0) + estimate.value
      }
      return {
        calls: model.length, sessions: new Set(model.map(row => row.sessionId).filter(Boolean)).size,
        errors: errorCount, errorRate: model.length ? errorCount / model.length : null,
        cancelled: model.filter(row => row.status === 'cancelled').length,
        incomplete: model.filter(row => row.status === 'incomplete').length,
        toolCalls: tools.length, toolErrorRate: tools.length ? tools.filter(row => row.status === 'error').length / tools.length : null,
        p95Ms: ms.length ? ms[Math.ceil(ms.length * 0.95) - 1] : null,
        totalTokens: model.reduce((n, row) => n + (row.usage?.totalTokens ?? 0), 0),
        costs, unpricedCalls,
        rated: rated.length, averageScore: rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null,
      }
    }
    const ended = snapshot.records.filter(row => row.phase === 'end' && Date.parse(row.at) >= since)
    for (const row of ended) {
      // 图表以本机时区分日，与界面的本地时间一致。
      const date = new Date(row.at)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      if (!daily.has(key)) daily.set(key, [])
      daily.get(key).push(row)
      if (row.kind !== 'model') continue
      const version = `${row.provider}/${row.model}:${row.personaVersion ?? row.promptVersion}:${row.toolsVersion}`
      if (!groups.has(version)) groups.set(version, [])
      groups.get(version).push(row)
    }
    const summary = summarize(ended)
    const baseline = summarize(snapshot.records.filter(row => row.phase === 'end' && Date.parse(row.at) >= since - count * 86_400_000 && Date.parse(row.at) < since))
    const closed = new Set(snapshot.records.filter(row => row.kind === 'model' && row.phase === 'end').map(row => row.spanId))
    summary.unclosed = snapshot.records.filter(row => row.kind === 'model' && row.phase === 'start' && Date.parse(row.at) >= since && !closed.has(row.spanId)).length
    const warnings = []
    if (snapshot.health.historical) warnings.push('包含旧探针补录：会话、工具执行和提示词版本存在缺失，历史调用不代表完整链路')
    if (snapshot.health.truncated || snapshot.health.malformed || snapshot.health.droppedEvents || snapshot.health.remote.gap || snapshot.health.remote.state === 'error') warnings.push('观测数据存在缺口，趋势只代表已采集样本')
    if (summary.calls < cfg.minimumSamples) warnings.push('模型样本不足，暂不判断执行回归')
    else if (summary.errorRate > cfg.errorRateWarning) warnings.push('模型执行错误率超过配置门槛')
    if (summary.toolCalls >= cfg.minimumSamples && summary.toolErrorRate > cfg.toolErrorRateWarning) warnings.push('工具错误率超过配置门槛')
    if (summary.rated < cfg.minimumScores) warnings.push('人工评分不足，回答质量暂不可判断')
    else if (summary.averageScore < cfg.scoreWarning) warnings.push('人工平均分低于配置门槛')
    if (summary.unclosed) warnings.push(`${summary.unclosed} 次调用尚未记录终态；可能仍在执行或被重启打断`)
    if (summary.calls >= cfg.minimumSamples && baseline.calls >= cfg.minimumSamples) {
      if (summary.errorRate - baseline.errorRate > cfg.errorRateIncreaseWarning) warnings.push('模型错误率较前一个同长度窗口上升，建议复核任务差异')
      if (baseline.p95Ms > 0 && summary.p95Ms / baseline.p95Ms > cfg.latencyRatioWarning) warnings.push('P95 耗时较前一个同长度窗口上升')
      for (const [currency, value] of Object.entries(summary.costs)) {
        if (baseline.costs[currency] > 0 && (value / summary.calls) / (baseline.costs[currency] / baseline.calls) > cfg.costRatioWarning) warnings.push(`${currency} 平均每次调用估价较前一窗口上升，建议核对上下文长度`)
      }
    }
    return {
      summary, baseline, warnings, thresholds: { ...cfg, relay: undefined }, health: snapshot.health,
      daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => ({ date, ...summarize(rows) })),
      versions: [...groups.values()].map(rows => ({
        model: rows[0].model, provider: rows[0].provider,
        promptVersion: rows[0].promptVersion, toolsVersion: rows[0].toolsVersion,
        personaVersion: rows[0].personaVersion, systemVariants: new Set(rows.map(row => row.promptVersion).filter(Boolean)).size,
        ...summarize(rows),
      })).sort((a, b) => b.calls - a.calls).slice(0, 100),
    }
  }

  /** 参数 row/providers：调用用量和模型价格表；缓存计入输入档位，币种分开累计。 */
  estimate_cost(row, providers) {
    if (!row.usage) return undefined
    const model = providers[row.provider]?.models?.find(item => item.id === row.model)
    const price = model?.pricing
    if (!price || price.unit !== 'per_million_tokens') return undefined
    const input = row.usage.inputTokens ?? 0
    const cache = row.usage.cacheReadTokens ?? 0
    const write = row.usage.cacheWriteTokens ?? 0
    const total = input + cache + write
    const tier = Array.isArray(price.tiers) ? price.tiers.find(item => total <= item.maxInputTokens) : price
    if (!tier || ![tier.input, tier.output, tier.cacheRead ?? tier.input, tier.cacheWrite ?? tier.input].every(value => Number.isFinite(value) && value >= 0)) return undefined
    return {
      currency: String(price.currency ?? 'CNY').slice(0, 8),
      value: (input * tier.input + cache * (tier.cacheRead ?? tier.input) + write * (tier.cacheWrite ?? tier.input) + (row.usage.outputTokens ?? 0) * tier.output) / 1_000_000,
    }
  }

  /** 无参数；关闭本模块持有的 SQLite 连接，供测试及服务退出使用。 */
  close() {
    this.db?.close()
    this.db = undefined
  }
}
