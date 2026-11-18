/**
 * 主动研究调度：静默地在后台同步画像、查资料、挑时机播报。
 * 参数：store / researcher / delivery / rhythm，以及画像与时间线只读接口。
 */
import { probe } from '../diagnostics/probe.js';
import { ProactiveStore } from './ProactiveStore.js';
/** 主动研究调度器。 */
export class ProactiveScheduler {
    constructor(options) {
        this.options = options;
        this.busy = false;
        this.stopped = false;
    }
    /** 启动：先跑一次，再按 tick 轮询。 */
    start() {
        if (this.timer !== undefined) return;
        const tick_ms = this.options.tick_ms ?? 60_000;
        probe('proactive', 'scheduler.started', {
            tick_ms
        });
        this.timer = setInterval(()=>{
            void this.tick();
        }, tick_ms);
        this.timer.unref?.();
        void this.tick();
    }
    /** 停止调度。 */
    stop() {
        this.stopped = true;
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
    }
    /** 一轮：同步画像、查一个主题、尝试播报。 */
    async tick() {
        if (this.busy || this.stopped) return;
        this.busy = true;
        const now = Date.now();
        const force = this.options.store.force_requested();
        try {
            const notes = await this.read_profile();
            if (notes !== '') {
                this.options.rhythm.update_from_notes(notes);
                const hash = ProactiveStore.hash(notes);
                if (this.options.store.state().profile_hash !== hash) {
                    const topics = this.options.store.sync_profile(notes);
                    this.options.store.set_state({
                        profile_hash: hash
                    });
                    probe('proactive', 'profile.synced', {
                        topics: topics.length
                    });
                }
            }
            const last_user_at = await this.last_user_at();
            await this.options.researcher.run_due(now, force);
            await this.options.delivery.flush(now, last_user_at, force);
        } catch (error) {
            probe('proactive', 'tick.failed', {
                error: String(error).slice(0, 180)
            });
        } finally{
            if (force) this.options.store.clear_force();
            this.busy = false;
        }
    }
    /** 读主人画像备注。 */
    async read_profile() {
        try {
            const node = await this.options.graph.find('主人');
            return node?.notes ?? '';
        } catch  {
            return '';
        }
    }
    /** 找主人最近一次发消息的时间。 */
    async last_user_at() {
        try {
            const days = await this.options.timeline.list_days();
            const last = days[days.length - 1];
            if (last === undefined) return undefined;
            const day = await this.options.timeline.read_day(last.date);
            let ts;
            for (const entry of day.entries){
                if (entry.role !== 'user') continue;
                if (ts === undefined || entry.ts > ts) ts = entry.ts;
            }
            return ts;
        } catch  {
            return undefined;
        }
    }
}
