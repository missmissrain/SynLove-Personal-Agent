/**
 * 主动研究的本地状态：主题、待播卡片、每日预算。
 * 参数：dir 为 runtime/dsh/proactive；所有文件都放在这个目录下。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { derive_topics, merge_topics, type ProactiveTopic } from './ProactiveTopic.ts'

/** 一张待播或已播的发现卡片。 */
export interface ProactiveCard {
  readonly id: string
  readonly topic_id: string
  readonly title: string
  readonly text: string
  readonly sources: readonly string[]
  readonly created_at: number
  readonly status: 'pending' | 'sent' | 'expired'
  readonly sent_at?: number
}

/** 调度状态（按天重置）。 */
export interface ProactiveState {
  readonly version: number
  readonly day: string
  readonly searches: number
  readonly profile_hash?: string
  /** 上次成功播报的时间；用于两条之间留冷却。 */
  readonly last_delivery_at?: number
  /** 下次主动搜索的时间；用来把频率压到 2-3 天一次。 */
  readonly next_research_at?: number
}

/** 本地日期（YYYY-MM-DD）。 */
function local_day(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 主动研究本地状态。 */
export class ProactiveStore {
  constructor(private readonly dir: string) {
    mkdirSync(this.dir, { recursive: true })
  }

  /** 拼出状态文件路径。 */
  private file(name: string): string {
    return join(this.dir, name)
  }

  /** 读取主题列表；文件损坏时返回空。 */
  topics(): ProactiveTopic[] {
    try {
      const path = this.file('topics.json')
      if (!existsSync(path)) return []
      const data = JSON.parse(readFileSync(path, 'utf8')) as { topics?: ProactiveTopic[] }
      return Array.isArray(data.topics) ? data.topics.filter(item => typeof item?.id === 'string') : []
    } catch {
      return []
    }
  }

  /** 保存主题列表。 */
  save_topics(topics: readonly ProactiveTopic[]): void {
    writeFileSync(this.file('topics.json'), JSON.stringify({ version: 1, topics }, null, 2), 'utf8')
  }

  /** 按最新画像同步主题，返回同步后的列表。 */
  sync_profile(notes: string): ProactiveTopic[] {
    const merged = merge_topics(this.topics(), derive_topics(notes))
    this.save_topics(merged)
    return merged
  }

  /** 读取所有卡片。 */
  cards(): ProactiveCard[] {
    try {
      const path = this.file('cards.jsonl')
      if (!existsSync(path)) return []
      const out: ProactiveCard[] = []
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          const card = JSON.parse(line) as ProactiveCard
          if (typeof card?.id === 'string' && typeof card.text === 'string') out.push(card)
        } catch {
          // 单行坏掉不影响其它卡片。
        }
      }
      return out
    } catch {
      return []
    }
  }

  /** 追加一张卡片，并把文件控制在 300 行以内。 */
  append_card(card: ProactiveCard): void {
    const path = this.file('cards.jsonl')
    appendFileSync(path, JSON.stringify(card) + '\n', 'utf8')
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
      if (lines.length > 300) writeFileSync(path, lines.slice(-200).join('\n') + '\n', 'utf8')
    } catch {
      // 压缩失败不影响新卡片。
    }
  }

  /** 标记卡片已播。 */
  mark_sent(id: string, sent_at: number): void {
    this.rewrite_cards(card => card.id === id ? { ...card, status: 'sent', sent_at } : card)
  }

  /** 把超过保留期的待播卡片标成过期。 */
  expire(max_age_ms: number, now: number): void {
    this.rewrite_cards(card => card.status === 'pending' && now - card.created_at > max_age_ms
      ? { ...card, status: 'expired' }
      : card)
  }

  /** 重写卡片文件，应用一次转换。 */
  private rewrite_cards(change: (card: ProactiveCard) => ProactiveCard): void {
    const cards = this.cards().map(change)
    writeFileSync(this.file('cards.jsonl'), cards.map(card => JSON.stringify(card)).join('\n') + '\n', 'utf8')
  }

  /** 读取调度状态。 */
  state(): ProactiveState {
    try {
      const path = this.file('state.json')
      if (!existsSync(path)) return { version: 1, day: local_day(Date.now()), searches: 0 }
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProactiveState>
      return {
        version: 1,
        day: typeof raw.day === 'string' ? raw.day : local_day(Date.now()),
        searches: Number(raw.searches ?? 0),
        ...typeof raw.profile_hash === 'string' ? { profile_hash: raw.profile_hash } : {},
        ...typeof raw.last_delivery_at === 'number' ? { last_delivery_at: raw.last_delivery_at } : {},
        ...typeof raw.next_research_at === 'number' ? { next_research_at: raw.next_research_at } : {},
      }
    } catch {
      return { version: 1, day: local_day(Date.now()), searches: 0 }
    }
  }

  /** 合并写入调度状态。 */
  set_state(patch: Partial<ProactiveState>): void {
    writeFileSync(this.file('state.json'), JSON.stringify({ ...this.state(), ...patch, version: 1 }, null, 2), 'utf8')
  }

  /** 占用一次当日搜索额度；额度用完返回 false。 */
  bump_budget(now: number, max: number): boolean {
    const state = this.state()
    const day = local_day(now)
    const searches = state.day === day ? state.searches : 0
    if (searches >= max) return false
    this.set_state({ day, searches: searches + 1 })
    return true
  }

  /** 是否存在强制跑一次的标记。 */
  force_requested(): boolean {
    return existsSync(this.file('force-once'))
  }

  /** 是否存在“强制提醒一次”的标记。 */
  force_nudge_requested(): boolean {
    return existsSync(this.file('force-nudge'))
  }

  /** 删除强制提醒标记。 */
  clear_force_nudge(): void {
    try {
      unlinkSync(this.file('force-nudge'))
    } catch {
      // 已经删掉就没事。
    }
  }

  /** 这条推断是否在跳过期内。 */
  skipped(key: string, now: number): boolean {
    try {
      const path = this.file('skip.json')
      if (!existsSync(path)) return false
      const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>
      return Number(data[key] ?? 0) > now
    } catch {
      return false
    }
  }

  /** 标记一条推断在一段时间内不再尝试；until 传 0 表示清除。 */
  mark_skipped(key: string, until: number): void {
    try {
      const path = this.file('skip.json')
      const data = existsSync(path)
        ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>
        : {}
      data[key] = until
      writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
    } catch {
      // 写不了就下次再试。
    }
  }

  /** 删除强制标记。 */
  clear_force(): void {
    try {
      unlinkSync(this.file('force-once'))
    } catch {
      // 已经删掉就没事。
    }
  }

  /** 稳定哈希，用于判断画像或卡片有没有变。 */
  static hash(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }
}
