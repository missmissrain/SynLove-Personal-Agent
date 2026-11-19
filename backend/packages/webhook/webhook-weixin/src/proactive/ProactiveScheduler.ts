/**
 * 主动研究调度：静默地在后台同步画像、查资料、挑时机播报。
 * 参数：store / researcher / delivery / rhythm，以及画像与时间线只读接口。
 */
import { probe } from '../diagnostics/probe.ts'
import { ProactiveStore } from './ProactiveStore.ts'
import type { ProactiveResearcher } from './ProactiveResearcher.ts'
import type { ProfileRhythm } from './ProfileRhythm.ts'

/** 画像只读接口。 */
export interface ProactiveGraphLike {
  find(name: string): Promise<{ readonly notes?: string } | undefined>
}

/** 时间线只读接口。 */
export interface ProactiveTimelineLike {
  list_days(): Promise<ReadonlyArray<{ readonly date: string }>>
  read_day(date: string): Promise<{ readonly entries: ReadonlyArray<{ readonly ts: number; readonly role: string }> }>
}

/** 任何能按时间播报的组件。 */
export interface ProactiveFlusher {
  flush(now: number, last_user_at: number | undefined, force: boolean): Promise<void>
}

/** 构造参数。 */
export interface ProactiveSchedulerOptions {
  readonly store: ProactiveStore
  readonly researcher: ProactiveResearcher
  readonly delivery: ProactiveFlusher
  readonly rhythm: ProfileRhythm
  readonly graph: ProactiveGraphLike
  readonly timeline: ProactiveTimelineLike
  readonly tick_ms?: number
}

/** 主动研究调度器。 */
export class ProactiveScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false
  private stopped = false

  constructor(private readonly options: ProactiveSchedulerOptions) {}

  /** 启动：先跑一次，再按 tick 轮询。 */
  start(): void {
    if (this.timer !== undefined) return
    const tick_ms = this.options.tick_ms ?? 60_000
    probe('proactive', 'scheduler.started', { tick_ms })
    this.timer = setInterval(() => { void this.tick() }, tick_ms)
    this.timer.unref?.()
    void this.tick()
  }

  /** 停止调度。 */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 一轮：同步画像、查一个主题、尝试播报。 */
  private async tick(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    const now = Date.now()
    const force = this.options.store.force_requested()
    const force_nudge = this.options.store.force_nudge_requested()
    try {
      const notes = await this.read_profile()
      if (notes !== '') {
        this.options.rhythm.update_from_notes(notes)
        const hash = ProactiveStore.hash(notes)
        if (this.options.store.state().profile_hash !== hash) {
          this.options.store.set_state({ profile_hash: hash })
          probe('proactive', 'profile.synced')
        }
      }
      const last_user_at = await this.last_user_at()
      await this.options.researcher.run_due(now, force)
      await this.options.delivery.flush(now, last_user_at, force_nudge)
    } catch (error) {
      probe('proactive', 'tick.failed', { error: String(error).slice(0, 180) })
    } finally {
      if (force) this.options.store.clear_force()
      if (force_nudge) this.options.store.clear_force_nudge()
      this.busy = false
    }
  }

  /** 读主人画像备注。 */
  private async read_profile(): Promise<string> {
    try {
      const node = await this.options.graph.find('主人')
      return node?.notes ?? ''
    } catch {
      return ''
    }
  }

  /** 找主人最近一次发消息的时间。 */
  private async last_user_at(): Promise<number | undefined> {
    try {
      const days = await this.options.timeline.list_days()
      const last = days[days.length - 1]
      if (last === undefined) return undefined
      const day = await this.options.timeline.read_day(last.date)
      let ts: number | undefined
      for (const entry of day.entries) {
        if (entry.role !== 'user') continue
        if (ts === undefined || entry.ts > ts) ts = entry.ts
      }
      return ts
    } catch {
      return undefined
    }
  }
}
