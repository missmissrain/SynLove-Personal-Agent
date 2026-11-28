import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../diagnostics/probe.js';
import { update_graph_from_records } from './graphUpdater.js';
export function start_graph_scheduler(options) {
    const idle_ms = options.idle_ms ?? Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? '3')) * 3_600_000;
    const interval_ms = options.interval_ms ?? Math.max(1, Number(process.env.DSH_TIMELINE_CHECK_MINUTES ?? '5')) * 60_000;
    const max_days = options.max_days ?? 7;
    let current;
    let stopped = false;
    const execute = async (now)=>{
        try {
            // 回溯重跑：存在 runtime/graph-backfill.request 时，从 0 号游标重扫指定天数。
            const marker = join(process.env.DSH_HOME ?? join(process.cwd(), 'runtime', 'dsh'), 'graph-backfill.request');
            let backfill = false;
            let backfill_days = max_days;
            let backfill_full = false;
            try {
                if (existsSync(marker)) {
                    const raw = JSON.parse(readFileSync(marker, 'utf8'));
                    backfill = true;
                    backfill_days = Math.max(1, Math.min(90, Number(raw.days ?? 30)));
                    backfill_full = raw.full_scan === true;
                    probe('graph', 'backfill.requested', { days: backfill_days });
                }
            } catch { backfill = false; }
            const since = backfill ? 0 : await options.graph.last_update_ms() ?? 0;
            const done_ids = new Set(await options.graph.last_update_ids());
            const days = (await options.timeline.list_days()).slice(-(backfill ? backfill_days : max_days));
            const all = (await Promise.all(days.map((day)=>options.timeline.read_day(day.date)))).flatMap((day)=>day.entries).filter((item)=>item.role !== 'rehearsal' && item.session_id !== 'rehearsal');
            const fresh = all.filter((item)=>item.ts > since || item.ts === since && !done_ids.has(item.id)).sort((a, b)=>a.ts - b.ts);
            const records = fresh.map((item)=>({
                    date: new Date(item.ts).toISOString().slice(0, 10),
                    role: item.role,
                    text: item.text
                }));
            if (records.length === 0) return undefined;
            const last_ts = Math.max(...all.map((item)=>item.ts), since);
            const ids_at_watermark = all.filter((item)=>item.ts === last_ts).map((item)=>item.id);
            if (!backfill && now - last_ts < idle_ms) return undefined;
            probe('graph', 'scheduler.started_update', {
                records: records.length,
                since
            });
            const result = await update_graph_from_records({
                graph: options.graph,
                complete: options.complete,
                ...(backfill && backfill_full ? { full_scan: true } : {})
            }, records);
            if (backfill) {
                try { unlinkSync(marker); } catch { }
                probe('graph', 'backfill.done', { ...result });
            }
            await options.graph.set_last_update(last_ts, ids_at_watermark);
            options.on_update?.(result);
            return result;
        } catch (error) {
            probe('graph', 'scheduler.failed', {
                error: String(error)
            });
            return undefined;
        }
    };
    const run_once = async (now = Date.now())=>{
        if (current !== undefined) {
            probe('graph', 'scheduler.joined_busy');
            return current;
        }
        current = execute(now);
        try {
            return await current;
        } finally {
            current = undefined;
        }
    };
    const ready = async ()=>{
        while (current !== undefined) await current.catch(() => undefined);
    };
    // 外部调度（自迭代服务）时只提供 run_once，不自己起定时器。
    const timer = options.auto_start === false ? undefined : setInterval(()=>{
        void run_once();
    }, interval_ms);
    if (timer !== undefined) {
        // 启动先跑一次：有回溯标记时立刻生效。
        void run_once();
        timer.unref?.();
    }
    probe('graph', options.auto_start === false ? 'scheduler.external' : 'scheduler.started', {
        interval_ms,
        idle_ms,
        max_days
    });
    return {
        run_once,
        ready,
        stop () {
            if (stopped) return;
            stopped = true;
            if (timer !== undefined) clearInterval(timer);
            probe('graph', 'scheduler.stopped');
        }
    };
}