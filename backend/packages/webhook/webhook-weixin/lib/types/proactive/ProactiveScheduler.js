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
    /** 启动：自建定时器时先跑一次再轮询；外部驱动时只登记。 */
    start() {
        if (this.options.auto_start === false) {
            probe('proactive', 'scheduler.external', {});
            return;
        }
        if (this.timer !== undefined) return;
        const tick_ms = this.options.tick_ms ?? 60_000;
        probe('proactive', 'scheduler.started', {
            tick_ms
        });
        this.timer = setInterval(()=>{
            void this.run_once();
        }, tick_ms);
        this.timer.unref?.();
        void this.run_once();
    }
    /** 停止调度。 */
    stop() {
        this.stopped = true;
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
    }
    /** 一轮：同步画像、查一个主题、尝试播报。 */
    async run_once() {
        const at = Date.now();
        if (this.busy) return {
            ran: false,
            at,
            skipped: 'busy'
        };
        if (this.stopped) return {
            ran: false,
            at,
            skipped: 'stopped'
        };
        this.busy = true;
        const now = Date.now();
        const force = this.options.store.force_requested();
        const force_nudge = this.options.store.force_nudge_requested();
        try {
            const notes = await this.read_profile();
            if (notes !== '') {
                this.options.rhythm.update_from_notes(notes);
                const hash = ProactiveStore.hash(notes);
                if (this.options.store.state().profile_hash !== hash) {
                    this.options.store.set_state({ profile_hash: hash });
                    probe('proactive', 'profile.synced');
                }
            }
            const last_user_at = await this.last_user_at();
            await this.options.researcher.run_due(now, force);
            await this.options.delivery.flush(now, last_user_at, force_nudge);
        } catch (error) {
            probe('proactive', 'tick.failed', {
                error: String(error).slice(0, 180)
            });
            return {
                ran: false,
                at,
                skipped: 'failed'
            };
        } finally{
            if (force) this.options.store.clear_force();
            if (force_nudge) this.options.store.clear_force_nudge();
            this.busy = false;
        }
        return {
            ran: true,
            at
        };
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
