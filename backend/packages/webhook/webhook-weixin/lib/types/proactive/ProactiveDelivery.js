/**
 * 主动播报：按画像作息挑合适时机，把待播卡片发出去。
 * 参数：store 为卡片状态，send 为实际发送函数，rhythm 为作息判断。
 */
import { probe } from '../diagnostics/probe.js';
/** 主动播报器。 */
export class ProactiveDelivery {
    constructor(options) {
        this.options = options;
    }
    /** 尝试播一条待播卡片。 */
    async flush(now, last_user_at, force) {
        const pending = this.options.store.cards().filter((card)=>card.status === 'pending').sort((a, b)=>a.created_at - b.created_at);
        // 图谱里没写作息就不主动打扰，不做任何默认时间推断。
        if (!force && !this.options.rhythm.is_configured()) return
        if (pending.length === 0) return;
        const gap = this.options.gap_ms ?? 2 * 3_600_000;
        const last = this.options.store.state().last_delivery_at;
        if (!force && last !== undefined && now - last < gap) {
            probe('proactive', 'delivery.cooldown', { left_ms: gap - (now - last) });
            return;
        }
        if (!force && this.options.rhythm.is_sleeping(new Date(now))) {
            probe('proactive', 'delivery.sleep');
            return;
        }
        const user_active = last_user_at !== undefined && now - last_user_at <= (this.options.active_window_ms ?? 10 * 60_000);
        const good = this.options.rhythm.is_good_moment(new Date(now));
        if (!force && !good && !user_active) {
            return;
        }
        const card = pending[0];
        if (!force && now - card.created_at < 120_000) return;
        const ok = await this.options.send(card.text);
        if (!ok) {
            probe('proactive', 'delivery.failed', {
                card: card.id
            });
            return;
        }
        this.options.store.mark_sent(card.id, now);
        this.options.store.set_state({ last_delivery_at: now });
        probe('proactive', 'delivery.sent', {
            card: card.id,
            topic: card.topic_id,
            chars: card.text.length
        });
    }
}
