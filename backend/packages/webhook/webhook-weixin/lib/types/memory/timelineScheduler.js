import { probe } from '../diagnostics/probe.js';
export function start_timeline_scheduler(options) {
    const interval_ms = options.interval_ms ?? Math.max(1, Number(process.env.DSH_TIMELINE_CHECK_MINUTES ?? '5')) * 60_000;
    let busy = false;
    let stopped = false;
    const run_once = async (now = Date.now())=>{
        if (stopped) return [];
        if (busy) {
            probe('timeline', 'check.skipped_busy');
            return [];
        }
        busy = true;
        try {
            const due = await options.store.days_needing_summary(now);
            if (due.length === 0) return [];
            probe('timeline', 'check.due', {
                dates: due
            });
            const updated = await options.store.summarize_due(options.summarizer, now);
            if (updated.length > 0) options.on_update?.(updated);
            return updated;
        } catch (error) {
            probe('timeline', 'scheduler.failed', {
                error: String(error)
            });
            return [];
        } finally{
            busy = false;
        }
    };
    // 外部调度（自迭代服务）时只提供 run_once，不自己起定时器。
    const timer = options.auto_start === false ? undefined : setInterval(()=>{
        void run_once();
    }, interval_ms);
    if (timer !== undefined) timer.unref?.();
    probe('timeline', options.auto_start === false ? 'scheduler.external' : 'scheduler.started', {
        interval_ms
    });
    return {
        run_once,
        stop () {
            if (stopped) return;
            stopped = true;
            if (timer !== undefined) clearInterval(timer);
            probe('timeline', 'scheduler.stopped');
        }
    };
}
