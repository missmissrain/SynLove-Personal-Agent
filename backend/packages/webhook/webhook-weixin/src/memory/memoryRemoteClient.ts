/**
 * 长期记忆远程端口。参数为 memory 服务地址、鉴权环境变量和请求超时。
 *
 * 该类只负责异步 HTTP 调用与轻量查询投影，不持有时间线或图谱副本，不访问本地记忆目录。
 * `SYNLOVE_MEMORY_BASE_URL` 可指向本机或远程服务；密钥只从 `SYNLOVE_MEMORY_API_KEY`
 * 读取。网络失败直接抛错，调用方不得回退到另一份本地数据库。
 */
import type {
  TimelineDay,
  TimelineDayMeta,
  TimelineEntry,
  TimelineReadFilter,
  TimelineSearchHit,
  TimelineSummarizer,
} from './timelineTypes.ts'
import type {
  GraphPath,
  GraphSnapshot,
  PersonNode,
  RelationEdge,
} from './graphTypes.ts'

type Json = Record<string, unknown>

/** 远程记忆客户端。 */
export class MemoryRemoteClient {
  private readonly base_url: string
  private readonly api_key: string
  private readonly timeout_ms: number

  constructor(options: {
    base_url?: string
    api_key?: string
    timeout_ms?: number
  } = {}) {
    this.base_url = (options.base_url
      ?? process.env.SYNLOVE_MEMORY_BASE_URL
      ?? 'http://127.0.0.1:8797/v1').replace(/\/+$/, '')
    this.api_key = options.api_key
      ?? process.env.SYNLOVE_MEMORY_API_KEY
      ?? ''
    this.timeout_ms = Math.max(1_000, Math.min(120_000, options.timeout_ms ?? 30_000))
  }

  /** 追加一条时间线记录；返回是否真的写入。 */
  async append(entry: TimelineEntry): Promise<boolean> {
    const result = await this.call('memory_append', { entry })
    return result.written === true
  }

  /** 按服务约定时区把时间戳转换为日期键。 */
  day_key(ts: number): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts))
  }

  /** 列出日期索引。 */
  async list_days(): Promise<TimelineDayMeta[]> {
    const result = await this.call('memory_days', { limit: 100 })
    return Array.isArray(result.days) ? result.days as TimelineDayMeta[] : []
  }

  /** 读取某日摘要。 */
  async read_summary(date: string): Promise<string | undefined> {
    const result = await this.call('memory_read', { date, includeEntries: false })
    return typeof result.summary === 'string' && result.summary !== '' ? result.summary : undefined
  }

  /** 读取某一天的完整时间线。 */
  async read_day(date: string, filter?: TimelineReadFilter): Promise<TimelineDay> {
    const day = await this.call('memory_read', { date, includeEntries: true }) as Json
    let entries = Array.isArray(day.entries) ? day.entries as TimelineEntry[] : []
    if (filter?.user_id !== undefined) entries = entries.filter(item => item.user_id === filter.user_id)
    if (filter?.session_id !== undefined) entries = entries.filter(item => item.session_id === filter.session_id)
    const summary = typeof day.summary === 'string' && day.summary !== '' ? day.summary : undefined
    return {
      ...summary === undefined ? {} : { summary },
      entries,
      meta: {
        date: String(day.date ?? date),
        timezone: 'Asia/Shanghai',
        entries: entries.length,
        user_entries: entries.filter(item => item.role === 'user').length,
        assistant_entries: entries.filter(item => item.role === 'assistant').length,
        updated_at: Date.now(),
      },
    }
  }

  /** 按日期和稳定 ID 更新记录字段。 */
  async update_entry(date: string, entry_id: string, patch: Json): Promise<boolean> {
    const result = await this.call('memory_update_entry', { date, entryId: entry_id, patch })
    return result.updated === true
  }

  /** 更新媒体附件的描述。 */
  async update_attachment_description(
    date: string,
    entry_id: string,
    attachment_id: string,
    description: string,
  ): Promise<boolean> {
    const result = await this.call('memory_update_attachment', {
      date, entryId: entry_id, attachmentId: attachment_id, description,
    })
    return result.updated === true
  }

  /** 更新某日摘要。 */
  async update_summary(date: string, summary: string, meta?: Json): Promise<boolean> {
    const result = await this.call('memory_update_summary', { date, summary, ...meta === undefined ? {} : { meta } })
    return result.updated === true
  }

  /** 返回已达到空闲阈值、且尚未生成摘要的日期。 */
  async days_needing_summary(now = Date.now()): Promise<string[]> {
    const dates = await this.list_days()
    const due: string[] = []
    const idle_ms = Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? '3')) * 3_600_000
    for (const item of dates) {
      if (item.last_ts === undefined || now - item.last_ts < idle_ms) continue
      if ((await this.read_summary(item.date)) === undefined) due.push(item.date)
    }
    return due
  }

  /** 调用注入的摘要器并把结果提交给远程记忆服务。 */
  async summarize_due(summarizer: TimelineSummarizer, now = Date.now()): Promise<string[]> {
    const updated: string[] = []
    for (const date of await this.days_needing_summary(now)) {
      const day = await this.read_day(date)
      const result = await summarizer({
        date,
        timezone: 'Asia/Shanghai',
        entries: day.entries,
        ...day.summary === undefined ? {} : { previous_summary: day.summary },
      })
      if (await this.update_summary(date, result.text, { model: result.model ?? '' })) updated.push(date)
    }
    return updated
  }

  /** 读取时间线统计。 */
  async stats(): Promise<{ days: number, entries: number, first_date?: string, last_date?: string }> {
    const days = await this.list_days()
    const result: { days: number, entries: number, first_date?: string, last_date?: string } = {
      days: days.length,
      entries: days.reduce((sum, day) => sum + day.entries, 0),
    }
    if (days.length > 0) {
      const first = days[days.length - 1]?.date
      const last = days[0]?.date
      if (first !== undefined) result.first_date = first
      if (last !== undefined) result.last_date = last
    }
    return result
  }

  /** 按关键词搜索时间线。 */
  async search(keyword: string, options: {
    limit?: number
    from?: string
    to?: string
  } = {}): Promise<TimelineSearchHit[]> {
    const result = await this.call('memory_search', { keyword, limit: options.limit ?? 20 })
    const hits = Array.isArray(result.hits) ? result.hits as Array<{ date: string, entry: TimelineEntry }> : []
    return hits
      .filter(hit => options.from === undefined || hit.date >= options.from)
      .filter(hit => options.to === undefined || hit.date <= options.to)
  }

  /** 读取一个日期或日期区间。 */
  async read_range(from: string, to?: string, filter?: TimelineReadFilter): Promise<TimelineDay[]> {
    const end = to ?? from
    const days = await this.list_days()
    const selected = days
      .map(item => item.date)
      .filter(date => date >= from && date <= end)
      .slice(-3)
    const result: TimelineDay[] = []
    for (const date of selected) {
      const day = await this.call('memory_read', { date, includeEntries: true }) as Json
      let entries = Array.isArray(day.entries) ? day.entries as TimelineEntry[] : []
      if (filter?.user_id !== undefined) entries = entries.filter(item => item.user_id === filter.user_id)
      if (filter?.session_id !== undefined) entries = entries.filter(item => item.session_id === filter.session_id)
      const summary = typeof day.summary === 'string' && day.summary !== '' ? day.summary : undefined
      result.push({
        ...summary === undefined ? {} : { summary },
        entries,
        meta: {
          date: day.date as string,
          timezone: 'Asia/Shanghai',
          entries: entries.length,
          user_entries: entries.filter(item => item.role === 'user').length,
          assistant_entries: entries.filter(item => item.role === 'assistant').length,
          updated_at: Date.now(),
        },
      })
    }
    return result
  }

  /** 读取图谱快照。 */
  async snapshot(): Promise<GraphSnapshot> {
    const result = await this.call('graph_snapshot')
    return {
      nodes: Array.isArray(result.nodes) ? result.nodes as PersonNode[] : [],
      edges: Array.isArray(result.edges) ? result.edges as RelationEdge[] : [],
    }
  }

  /** 确保图谱中心节点存在。 */
  async ensure_center(): Promise<void> {
    await this.call('graph_ensure_center')
  }

  /** 新增或更新人物节点。 */
  async upsert_person(person: Json): Promise<PersonNode> {
    const result = await this.call('graph_upsert_person', { person })
    return result.person as PersonNode
  }

  /** 新增或更新关系边。 */
  async upsert_edge(edge: Json): Promise<RelationEdge | undefined> {
    const result = await this.call('graph_upsert_edge', { edge })
    return result.edge as RelationEdge | undefined
  }

  /** 读取图谱增量水位。 */
  async last_update_ms(): Promise<number | undefined> {
    const result = await this.call('graph_watermark')
    return typeof result.ts === 'number' ? result.ts : undefined
  }

  /** 读取同一毫秒下已处理的记录 ID。 */
  async last_update_ids(): Promise<string[]> {
    const result = await this.call('graph_watermark')
    return Array.isArray(result.ids) ? result.ids.filter((id): id is string => typeof id === 'string') : []
  }

  /** 提交图谱增量水位。 */
  async set_last_update(ts: number, ids: readonly string[]): Promise<void> {
    await this.call('graph_watermark', { update: { ts, ids } })
  }

  /** 找到人物节点。 */
  async find(name_or_id: string): Promise<PersonNode | undefined> {
    const snapshot = await this.snapshot()
    const needle = name_or_id.trim().toLocaleLowerCase().replace(/\s+/g, '')
    return snapshot.nodes.find(node => node.id === name_or_id
      || node.name.toLocaleLowerCase().replace(/\s+/g, '') === needle
      || (node.aliases ?? []).some(alias => alias.toLocaleLowerCase().replace(/\s+/g, '') === needle))
  }

  /** 返回全部节点。 */
  async nodes(): Promise<PersonNode[]> { return [...(await this.snapshot()).nodes] }

  /** 返回从某节点出发的边。 */
  async edges_from(id: string): Promise<RelationEdge[]> {
    return (await this.snapshot()).edges.filter(edge => edge.from === id)
  }

  /** 返回指向某节点的边。 */
  async edges_to(id: string): Promise<RelationEdge[]> {
    return (await this.snapshot()).edges.filter(edge => edge.to === id)
  }

  /** 返回节点属性；年龄等派生字段由服务端存储值直接提供。 */
  async attributes(name: string): Promise<PersonNode | undefined> { return this.find(name) }

  /** 返回某人的关系网。 */
  async neighborhood(name: string, options: { max_depth?: number } = {}): Promise<Array<{ name: string, label: string, depth: number }>> {
    const snapshot = await this.snapshot()
    const start = await this.find_in_snapshot(snapshot, name)
    if (start === undefined) return []
    const max_depth = Math.max(1, Math.min(6, options.max_depth ?? 2))
    const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
    const outgoing = new Map<string, RelationEdge[]>()
    for (const edge of snapshot.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge])
    const seen = new Map<string, { name: string, label: string, depth: number }>()
    let frontier = [start.id]
    for (let depth = 1; depth <= max_depth; depth += 1) {
      const next: string[] = []
      for (const id of frontier) {
        for (const edge of outgoing.get(id) ?? []) {
          if (edge.to === start.id || seen.has(edge.to)) continue
          seen.set(edge.to, { name: nodes.get(edge.to)?.name ?? edge.to, label: edge.label, depth })
          next.push(edge.to)
        }
      }
      frontier = next
    }
    return [...seen.values()]
  }

  /** 查找两人之间的简单路径。 */
  async paths(from_name: string, to_name: string, options: { max_depth?: number } = {}): Promise<GraphPath[]> {
    const snapshot = await this.snapshot()
    const start = await this.find_in_snapshot(snapshot, from_name)
    const end = await this.find_in_snapshot(snapshot, to_name)
    if (start === undefined || end === undefined) return []
    const max_depth = Math.max(1, Math.min(8, options.max_depth ?? 4))
    const nodes = new Map(snapshot.nodes.map(node => [node.id, node]))
    const outgoing = new Map<string, RelationEdge[]>()
    for (const edge of snapshot.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge])
    const result: GraphPath[] = []
    const walk = (current: string, visited: Set<string>, hops: RelationEdge[]): void => {
      if (current === end.id && hops.length > 0) {
        result.push({
          node_ids: [start.id, ...hops.map(edge => edge.to)],
          names: [start.name, ...hops.map(edge => nodes.get(edge.to)?.name ?? edge.to)],
          hops: hops.map(edge => ({ from: edge.from, to: edge.to, label: edge.label })),
          readable: [start.name, ...hops.map(edge => nodes.get(edge.to)?.name ?? edge.to)].join(' → '),
        })
        return
      }
      if (hops.length >= max_depth) return
      for (const edge of outgoing.get(current) ?? []) {
        if (visited.has(edge.to)) continue
        visited.add(edge.to)
        walk(edge.to, visited, [...hops, edge])
        visited.delete(edge.to)
      }
    }
    walk(start.id, new Set([start.id]), [])
    return result.sort((a, b) => a.hops.length - b.hops.length)
  }

  private async find_in_snapshot(snapshot: GraphSnapshot, name_or_id: string): Promise<PersonNode | undefined> {
    const needle = name_or_id.trim().toLocaleLowerCase().replace(/\s+/g, '')
    return snapshot.nodes.find(node => node.id === name_or_id
      || node.name.toLocaleLowerCase().replace(/\s+/g, '') === needle
      || (node.aliases ?? []).some(alias => alias.toLocaleLowerCase().replace(/\s+/g, '') === needle))
  }

  private async call(name: string, arguments_: Json = {}): Promise<Json> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout_ms)
    try {
      const response = await fetch(`${this.base_url}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.api_key === '' ? {} : { Authorization: `Bearer ${this.api_key}` },
        },
        body: JSON.stringify({
          requestId: `memory-${crypto.randomUUID()}`,
          message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } },
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`memory 服务 HTTP ${response.status}`)
      let operation = await response.json() as Json
      while (operation.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 100))
        const id = String(operation.requestId ?? '')
        const status = await fetch(`${this.base_url}/operations/${encodeURIComponent(id)}`, {
          headers: this.api_key === '' ? {} : { Authorization: `Bearer ${this.api_key}` },
          signal: controller.signal,
        })
        operation = await status.json() as Json
      }
      if (operation.state !== 'done') throw new Error(`memory 服务任务状态 ${String(operation.state)}`)
      const result = ((operation.result as Json | undefined)?.result as Json | undefined)
        ?? operation.result as Json | undefined
      if (result?.isError === true) throw new Error(String(result.content ?? 'memory 服务调用失败'))
      return (result?.structuredContent as Json | undefined) ?? {}
    } finally {
      clearTimeout(timer)
    }
  }
}
