/**
 * 主动播报：按画像作息挑合适时机，把待播卡片发出去。
 * 参数：store 为卡片状态，send 为实际发送函数，rhythm 为作息判断。
 */
import { probe } from '../diagnostics/probe.ts'
import type { ProactiveStore } from './ProactiveStore.ts'
import type { ProfileRhythm } from './ProfileRhythm.ts'

/** 构造参数。 */
export interface ProactiveDeliveryOptions {
  readonly store: ProactiveStore
  readonly send: (text: string) => Promise<boolean>
  readonly rhythm: ProfileRhythm
  readonly active_window_ms?: number
}

/** 主动播报器。 */
export class ProactiveDelivery {
  constructor(private readonly options: ProactiveDeliveryOptions) {}

  /**
   * 尝试播一条待播卡片。
   *
   * @param now - 当前毫秒时间戳。
   * @param last_user_at - 主人最近一次发消息的时间。
   * @param force - 是否忽略作息与卡片年龄（调试用）。
   */
  async flush(now: number, last_user_at: number | undefined, force: boolean): Promise<void> {
    const pending = this.options.store.cards()
      .filter(card => card.status === 'pending')
      .sort((a, b) => a.created_at - b.created_at)
    if (pending.length === 0) return
    if (!force && this.options.rhythm.is_sleeping(new Date(now))) {
      probe('proactive', 'delivery.sleep')
      return
    }
    const user_active = last_user_at !== undefined
      && now - last_user_at <= (this.options.active_window_ms ?? 10 * 60_000)
    const good = this.options.rhythm.is_good_moment(new Date(now))
    if (!force && !good && !user_active) {
      probe('proactive', 'delivery.wait', { moment: this.options.rhythm.moment(new Date(now)) })
      return
    }
    const card = pending[0]!
    if (!force && now - card.created_at < 120_000) return
    const ok = await this.options.send(card.text)
    if (!ok) {
      probe('proactive', 'delivery.failed', { card: card.id })
      return
    }
    this.options.store.mark_sent(card.id, now)
    probe('proactive', 'delivery.sent', { card: card.id, topic: card.topic_id, chars: card.text.length })
  }
}
