/**
 * 主动研究：到期主题联网搜索，让模型只挑“值得说”的变化写成卡片。
 * 参数：store 为本地状态，web 为 ctx.web 搜索服务，complete 为模型调用。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { probe } from '../diagnostics/probe.ts'
import { topic_due, type ProactiveTopic } from './ProactiveTopic.ts'
import { ProactiveStore } from './ProactiveStore.ts'

/** 搜索结果（只取用得到的字段）。 */
export interface ProactiveSearchResult {
  readonly content?: string
  readonly sources?: ReadonlyArray<{ readonly url: string; readonly title?: string }>
}

/** ctx.web 的最小接口。 */
export interface ProactiveWebLike {
  search(
    request: { readonly query: string; readonly maxResults?: number },
    signal?: AbortSignal,
  ): Promise<ProactiveSearchResult>
}

/** 构造参数。 */
export interface ProactiveResearcherOptions {
  readonly store: ProactiveStore
  readonly web: ProactiveWebLike | undefined
  readonly complete: (prompt: string, max_tokens?: number) => Promise<string>
  readonly prompt_path: string
  readonly max_per_day?: number
  readonly search_timeout_ms?: number
  readonly card_ttl_ms?: number
}

/** 主动研究器。 */
export class ProactiveResearcher {
  private readonly guidance: string

  constructor(private readonly options: ProactiveResearcherOptions) {
    this.guidance = existsSync(options.prompt_path)
      ? readFileSync(options.prompt_path, 'utf8')
      : '只输出要发给主人的话；没有实质变化就输出：无'
  }

  /**
   * 跑一个到期主题。
   *
   * @param now - 当前毫秒时间戳。
   * @param force - 是否忽略到期时间与每日额度（调试用）。
   */
  async run_due(now: number, force: boolean): Promise<void> {
    const due = this.options.store.topics()
      .filter(topic => force || topic_due(topic, now))
      .sort((a, b) => (a.last_checked_ms ?? 0) - (b.last_checked_ms ?? 0))
    if (due.length === 0) return
    if (!force && !this.options.store.bump_budget(now, this.options.max_per_day ?? 6)) {
      probe('proactive', 'research.budget_exhausted')
      return
    }
    await this.research(due[0]!, now)
  }

  /** 查一个主题并落卡片。 */
  private async research(topic: ProactiveTopic, now: number): Promise<void> {
    const web = this.options.web
    if (web === undefined) {
      probe('proactive', 'research.web_unavailable')
      return
    }
    probe('proactive', 'research.start', { topic: topic.id })
    let found: ProactiveSearchResult
    try {
      found = await web.search(
        { query: topic.query, maxResults: 6 },
        AbortSignal.timeout(this.options.search_timeout_ms ?? 120_000),
      )
    } catch (error) {
      probe('proactive', 'research.search_failed', { topic: topic.id, error: String(error).slice(0, 160) })
      this.touch(topic, now)
      return
    }
    const content = (found.content ?? '').trim()
    const sources = (found.sources ?? []).slice(0, 6)
    if (content === '' && sources.length === 0) {
      probe('proactive', 'research.empty', { topic: topic.id })
      this.touch(topic, now)
      return
    }
    const prompt = [
      this.guidance,
      '',
      `【本次主题】${topic.title}`,
      '【搜索正文】',
      content === '' ? '（空）' : content.slice(0, 6000),
      '',
      '【来源】',
      sources.map(item => `- ${item.url}${item.title === undefined ? '' : ' ' + item.title}`).join('\n'),
    ].join('\n')
    let text = ''
    try {
      text = (await this.options.complete(prompt, 900)).trim()
    } catch (error) {
      probe('proactive', 'research.model_failed', { topic: topic.id, error: String(error).slice(0, 160) })
      this.touch(topic, now)
      return
    }
    if (text === '' || text === '无' || (text.startsWith('无') && text.length <= 12)) {
      probe('proactive', 'research.no_change', { topic: topic.id })
      this.touch(topic, now)
      return
    }
    const hash = ProactiveStore.hash(text)
    if (this.options.store.topics().find(item => item.id === topic.id)?.last_hash === hash) {
      probe('proactive', 'research.same', { topic: topic.id })
      this.touch(topic, now, hash)
      return
    }
    this.options.store.append_card({
      id: `proactive-${now}-${randomBytes(3).toString('hex')}`,
      topic_id: topic.id,
      title: topic.title,
      text: text.slice(0, 1200),
      sources: sources.map(item => item.url).slice(0, 3),
      created_at: now,
      status: 'pending',
    })
    this.options.store.expire(this.options.card_ttl_ms ?? 72 * 3_600_000, now)
    this.touch(topic, now, hash)
    probe('proactive', 'card.created', { topic: topic.id, chars: text.length })
  }

  /** 记录本次检查时间，可选记录内容哈希。 */
  private touch(topic: ProactiveTopic, now: number, hash?: string): void {
    const topics = this.options.store.topics().map(item => item.id === topic.id
      ? { ...item, last_checked_ms: now, ...hash === undefined ? {} : { last_hash: hash } }
      : item)
    this.options.store.save_topics(topics)
  }
}
