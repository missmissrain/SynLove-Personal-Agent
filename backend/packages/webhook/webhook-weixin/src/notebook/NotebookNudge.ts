/**
 * 记事簿提醒：隔两三天轻提一句“最近记了几条”，不直接展开结果。
 * 参数：store / rhythm / complete / send；间隔默认 48-72 小时。
 */
import { existsSync, readFileSync } from 'node:fs'
import { probe } from '../diagnostics/probe.ts'
import type { NotebookStore } from './NotebookStore.ts'
import type { ProfileRhythm } from './ProfileRhythm.ts'

/** 构造参数。 */
export interface NotebookNudgeOptions {
  readonly store: NotebookStore
  readonly rhythm: ProfileRhythm
  readonly complete: (prompt: string, max_tokens?: number) => Promise<string>
  readonly prompt_path: string
  readonly send: (text: string) => Promise<boolean>
  readonly min_gap_ms?: number
  readonly max_gap_ms?: number
}

/** 记事簿提醒器。 */
export class NotebookNudge {
  private readonly guidance: string

  constructor(private readonly options: NotebookNudgeOptions) {
    this.guidance = existsSync(options.prompt_path)
      ? readFileSync(options.prompt_path, 'utf8')
      : '说最近记了几条，问主人想不想听详情；不要直接展开内容。'
  }

  /**
   * 到点就提一句。
   *
   * @param now - 当前毫秒时间戳。
   * @param last_user_at - 主人最近发消息的时间。
   * @param force - 是否忽略间隔与作息（调试用）。
   */
  async flush(now: number, last_user_at: number | undefined, force: boolean): Promise<void> {
    const pending = this.options.store.unread(7, now)
    // 图谱里没写作息就不主动打扰，不做任何默认时间推断。
    if (!force && !this.options.rhythm.is_configured()) return
    if (pending.length === 0) return
    if (!force && this.options.rhythm.is_sleeping(new Date(now))) return
    const active = last_user_at !== undefined && now - last_user_at <= 10 * 60_000
    const good = this.options.rhythm.is_good_moment(new Date(now))
    if (!force && !good && !active) return
    const next = this.options.store.state().next_nudge_at
    if (next === undefined) {
      this.schedule(now)
      probe('notebook', 'nudge.scheduled', { first: true })
      return
    }
    if (!force && now < next) {
      return
    }
    const picks = pending.slice(0, 3)
    const lines = picks.map(entry => `- ${entry.title}（${NotebookStore_age(entry.created_at, now)}）`).join('\n')
    const prompt = [this.guidance, '', '【最近记下的】', lines].join('\n')
    let text = ''
    try {
      text = (await this.options.complete(prompt, 300)).trim()
    } catch (error) {
      probe('notebook', 'nudge.model_failed', { error: String(error).slice(0, 160) })
      return
    }
    if (text === '' || text === '无') {
      this.schedule(now)
      probe('notebook', 'nudge.skip')
      return
    }
    if (await this.options.send(text)) {
      this.options.store.mark_mentioned(picks.map(entry => entry.id), now)
      this.schedule(now)
      probe('notebook', 'nudge.sent', { count: picks.length, chars: text.length })
    }
  }

  /** 安排下一次提醒：48-72 小时之间随机。 */
  private schedule(now: number): void {
    const min = this.options.min_gap_ms ?? 48 * 3_600_000
    const max = this.options.max_gap_ms ?? 72 * 3_600_000
    const next = now + min + Math.floor(Math.random() * Math.max(1, max - min))
    this.options.store.set_state({ next_nudge_at: next, last_nudge_at: now })
  }
}

/** 条目多久以前。 */
function NotebookStore_age(created_at: number, now: number): string {
  const hours = Math.max(0, Math.round((now - created_at) / 3_600_000))
  return hours < 1 ? '刚刚' : hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}
