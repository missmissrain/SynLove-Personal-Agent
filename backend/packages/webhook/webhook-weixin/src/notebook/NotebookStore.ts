/**
 * 记事簿：保存欣爱主动查过的东西，供聊天时查询与隔几天轻提一句。
 * 参数：dir 为 runtime/dsh/notebook；entries.jsonl 存条目，state.json 存提醒时间。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 记事簿条目。 */
export interface NotebookEntry {
  readonly id: string
  readonly topic_id: string
  readonly kind: string
  readonly title: string
  readonly summary: string
  readonly sources: readonly string[]
  readonly created_at: number
  /** 这条信息保持多久算新鲜（小时）。 */
  readonly fresh_hours: number
  /** 是否已经在聊天里提过。 */
  readonly mentioned_at?: number
}

/** 提醒状态。 */
export interface NotebookState {
  readonly version: number
  readonly next_nudge_at?: number
  readonly last_nudge_at?: number
}

/** 记事簿本地存储。 */
export class NotebookStore {
  constructor(private readonly dir: string) {
    mkdirSync(this.dir, { recursive: true })
  }

  /** 拼出文件路径。 */
  private file(name: string): string {
    return join(this.dir, name)
  }

  /** 读取所有条目。 */
  entries(): NotebookEntry[] {
    try {
      const path = this.file('entries.jsonl')
      if (!existsSync(path)) return []
      const out: NotebookEntry[] = []
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          const entry = JSON.parse(line) as NotebookEntry
          if (typeof entry?.id === 'string' && typeof entry.summary === 'string') out.push(entry)
        } catch {
          // 单行坏掉不影响其它条目。
        }
      }
      return out
    } catch {
      return []
    }
  }

  /** 追加一条记录，并控制在 500 行以内。 */
  append(input: {
    readonly topic_id: string
    readonly kind: string
    readonly title: string
    readonly summary: string
    readonly sources: readonly string[]
    readonly fresh_hours: number
    readonly created_at?: number
  }): NotebookEntry {
    const entry: NotebookEntry = {
      id: `note-${Date.now()}-${randomBytes(3).toString('hex')}`,
      topic_id: input.topic_id,
      kind: input.kind,
      title: input.title,
      summary: input.summary.slice(0, 2000),
      sources: input.sources.slice(0, 3),
      created_at: input.created_at ?? Date.now(),
      fresh_hours: input.fresh_hours,
    }
    const path = this.file('entries.jsonl')
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8')
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
      if (lines.length > 500) writeFileSync(path, lines.slice(-400).join('\n') + '\n', 'utf8')
    } catch {
      // 压缩失败不影响新条目。
    }
    // 第一次记东西时就把提醒排到 2-3 天后，别当天就来打扰。
    if (this.state().next_nudge_at === undefined) {
      const min = 48 * 3_600_000
      const max = 72 * 3_600_000
      this.set_state({ next_nudge_at: entry.created_at + min + Math.floor(Math.random() * (max - min)) })
    }
    return entry
  }

  /** 按 id 取一条。 */
  get(id: string): NotebookEntry | undefined {
    return this.entries().find(entry => entry.id === id)
  }

  /** 最近几天的条目，新的在前。 */
  recent(days: number, now: number, limit = 8): NotebookEntry[] {
    const since = now - Math.max(1, days) * 86_400_000
    return this.entries()
      .filter(entry => entry.created_at >= since)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit)
  }

  /** 关键词搜索标题、摘要和类型。 */
  search(query: string, now: number, limit = 8): NotebookEntry[] {
    const word = query.trim().toLowerCase()
    if (word === '') return []
    return this.entries()
      .filter(entry => `${entry.title}\n${entry.summary}\n${entry.kind}`.toLowerCase().includes(word))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit)
  }

  /** 最近几天还没在聊天里提过的条目。 */
  unread(days: number, now: number): NotebookEntry[] {
    const since = now - Math.max(1, days) * 86_400_000
    return this.entries()
      .filter(entry => entry.mentioned_at === undefined && entry.created_at >= since)
      .sort((a, b) => a.created_at - b.created_at)
  }

  /** 标记这些条目已经提过。 */
  mark_mentioned(ids: readonly string[], at: number): void {
    const set = new Set(ids)
    const entries = this.entries().map(entry => set.has(entry.id) ? { ...entry, mentioned_at: at } : entry)
    writeFileSync(this.file('entries.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  }

  /** 读取提醒状态。 */
  state(): NotebookState {
    try {
      const path = this.file('state.json')
      if (!existsSync(path)) return { version: 1 }
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<NotebookState>
      return {
        version: 1,
        ...typeof raw.next_nudge_at === 'number' ? { next_nudge_at: raw.next_nudge_at } : {},
        ...typeof raw.last_nudge_at === 'number' ? { last_nudge_at: raw.last_nudge_at } : {},
      }
    } catch {
      return { version: 1 }
    }
  }

  /** 写入提醒状态。 */
  set_state(patch: Partial<NotebookState>): void {
    writeFileSync(this.file('state.json'), JSON.stringify({ ...this.state(), ...patch, version: 1 }, null, 2), 'utf8')
  }

  /** 条目是否还在时效内。 */
  static fresh(entry: NotebookEntry, now: number): boolean {
    return now - entry.created_at <= entry.fresh_hours * 3_600_000
  }

  /** 条目到现在多少小时。 */
  static age_hours(entry: NotebookEntry, now: number): number {
    return Math.max(0, Math.round((now - entry.created_at) / 3_600_000))
  }
}

/** 进程内共享一个记事簿，路径固定为 $DSH_HOME/notebook。 */
let shared_instance: NotebookStore | undefined
export function shared_notebook(): NotebookStore {
  if (shared_instance === undefined) {
    const home = process.env.DSH_HOME ?? join(process.cwd(), 'runtime', 'dsh')
    shared_instance = new NotebookStore(join(home, 'notebook'))
  }
  return shared_instance
}
