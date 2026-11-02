import { probe, probe_timer } from '../diagnostics/probe.js';
import { ObservationRecorder } from '@deepseek-ai/dsh-llm';
const MAX_TEXT_CHARS = Number(process.env.DSH_WEIXIN_MAX_TEXT_CHARS ?? '1000');
function split_text(text, limit) {
    if (text.length <= limit) return [
        text
    ];
    const parts = [];
    let rest = text;
    while(rest.length > limit){
        const window = rest.slice(0, limit);
        const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf(' '));
        const at = cut > limit * 0.5 ? cut + 1 : limit;
        parts.push(rest.slice(0, at));
        rest = rest.slice(at);
    }
    if (rest.length > 0) parts.push(rest);
    return parts;
}
export class OutboundCoordinator {
    store;
    turn_context;
    sender;
    classify_retryable;
    record_entry;
    max_attempts;
    retry_base_ms;
    heartbeat_idle_ms;
    heartbeat_max_per_turn;
    send_min_gap_ms;
    send_batch_limit;
    last_send_at = new Map();
    last_send_any_at = 0;
    progress = new Map();
    draining = false;
    stopped = false;
    paused_until = 0;
    pause_timer;
    pause_logged_at = 0;
    rate_limit_streak = 0;
    rate_limit_cooldown_ms;
    rate_limit_cooldown_max_ms;
    no_token_defer_ms;
    parked_retention_ms;
    constructor(options){
        this.store = options.store;
        this.turn_context = options.turn_context;
        this.sender = options.sender;
        this.classify_retryable = options.classify_retryable;
        this.record_entry = options.record_entry;
        this.max_attempts = options.max_attempts ?? 5;
        this.retry_base_ms = options.retry_base_ms ?? 500;
        this.heartbeat_idle_ms = options.heartbeat_idle_ms ?? Number(process.env.DSH_WEIXIN_HEARTBEAT_IDLE_MS ?? '300000');
        this.heartbeat_max_per_turn = options.heartbeat_max_per_turn ?? 6;
        this.send_min_gap_ms = options.send_min_gap_ms ?? Number(process.env.DSH_WEIXIN_SEND_MIN_GAP_MS ?? '2200');
        this.send_batch_limit = options.send_batch_limit ?? Number(process.env.DSH_WEIXIN_SEND_BATCH_LIMIT ?? '3');
        this.rate_limit_cooldown_ms = options.rate_limit_cooldown_ms ?? Number(process.env.DSH_WEIXIN_RATE_LIMIT_COOLDOWN_MS ?? '60000');
        this.rate_limit_cooldown_max_ms = options.rate_limit_cooldown_max_ms ?? Number(process.env.DSH_WEIXIN_RATE_LIMIT_COOLDOWN_MAX_MS ?? '600000');
        this.no_token_defer_ms = options.no_token_defer_ms ?? Number(process.env.DSH_WEIXIN_NO_TOKEN_DEFER_MS ?? '300000');
        this.parked_retention_ms = options.parked_retention_ms ?? Number(process.env.DSH_WEIXIN_PARKED_RETENTION_MS ?? '21600000');
    }
    enqueue_assistant(input) {
        if (!input.text.trim()) return;
        const context = this.turn_context.resolve(input.session_id, input.turn);
        const record = this.store.enqueue_outbox({
            session_id: input.session_id,
            user_id: context?.user_id ?? input.user_id,
            kind: 'assistant',
            text: input.text,
            turn: input.turn,
            ...context?.context_token === undefined ? {} : {
                context_token: context.context_token
            }
        });
        if (record instanceof Promise) {
            void record.then((value)=>{
                ObservationRecorder.bind_outbound(value.outbound_id, input.session_id, input.turn);
            });
            return;
        }
        ObservationRecorder.bind_outbound(record.outbound_id, input.session_id, input.turn);
        void Promise.resolve(this.record_entry?.({
            id: record.outbound_id,
            ts: record.created_at,
            role: 'assistant',
            text: input.text,
            user_id: record.user_id,
            session_id: record.session_id,
            turn: input.turn
        })).catch((error)=>probe('timeline', 'append.failed', {
                id: record.outbound_id,
                error: String(error)
            }));
    }
    enqueue_notice(input) {
        if (!input.text.trim()) return;
        if (input.turn === undefined) {
            const trimmed = this.store.trim_pending_notices(input.session_id);
            if (trimmed instanceof Promise) void trimmed;
        }
        const fallback_token = input.context_token ?? this.turn_context.latest_token_if_fresh(input.session_id);
        const record = this.store.enqueue_outbox({
            session_id: input.session_id,
            user_id: input.user_id,
            kind: input.kind,
            text: input.text,
            ...input.turn === undefined ? {} : {
                turn: input.turn
            },
            ...fallback_token === undefined ? {} : {
                context_token: fallback_token
            }
        });
        if (record instanceof Promise) void record;
    }
    async drain() {
        if (this.stopped) return;
        const wait = this.paused_until - Date.now();
        if (wait > 0) {
            const now = Date.now();
            if (now - this.pause_logged_at > 5_000) {
                this.pause_logged_at = now;
                probe('outbound', 'drain.paused', {
                    remaining_ms: wait,
                    streak: this.rate_limit_streak
                });
            }
            if (this.pause_timer === undefined) {
                this.pause_timer = setTimeout(()=>{
                    this.pause_timer = undefined;
                    void this.drain();
                }, wait + 50);
                this.pause_timer.unref?.();
            }
            return;
        }
        if (this.draining) return;
        this.draining = true;
        try {
            const heads = await this.store.next_outbox_per_session();
            await Promise.all(heads.map((head)=>this.send_head(head)));
        } finally{
            this.draining = false;
        }
    }
    async send_head(record) {
        const handled = new Set();
        let current = record;
        let sent = 0;
        while(current !== undefined && !this.stopped){
            if (handled.has(current.outbound_id)) {
                probe('outbound', 'pump.guard_tripped', {
                    outbound_id: current.outbound_id
                });
                return;
            }
            handled.add(current.outbound_id);
            await this.throttle(current.session_id);
            const ok = await this.send_one(current);
            if (!ok) return;
            sent += 1;
            if (sent >= this.send_batch_limit) {
                probe('outbound', 'pump.batch_capped', {
                    session_id: current.session_id,
                    sent
                });
                return;
            }
            current = await this.store.next_outbox(current.session_id);
        }
    }
    async throttle(session_id) {
        const now = Date.now();
        const last_same = this.last_send_at.get(session_id) ?? 0;
        const wait_same = this.send_min_gap_ms - (now - last_same);
        const wait_any = Math.floor(this.send_min_gap_ms / 2) - (now - this.last_send_any_at);
        const wait = Math.max(0, wait_same, wait_any);
        if (wait > 0) {
            probe('outbound', 'throttle.wait', {
                session_id,
                wait_ms: wait
            });
            await new Promise((resolve)=>setTimeout(resolve, wait));
        }
        this.last_send_at.set(session_id, Date.now());
        this.last_send_any_at = Date.now();
    }
    async send_one(record) {
        const done = probe_timer('outbound', 'send.attempt', {
            outbound_id: record.outbound_id,
            session_id: record.session_id,
            kind: record.kind,
            sequence: record.sequence,
            attempt: record.attempt,
            turn: record.turn
        });
        await this.store.mark_outbox_sending(record.outbound_id);
        try {
            const send_token = record.context_token ?? this.turn_context.latest_token_if_fresh(record.session_id);
            if (send_token !== undefined && record.context_token === undefined) {
                probe('outbound', 'token.picked_at_send', {
                    outbound_id: record.outbound_id,
                    kind: record.kind
                });
            }
            const parts = split_text(record.text, MAX_TEXT_CHARS);
            const already_sent = new Set(record.sent_parts ?? []);
            let sent_any = already_sent.size > 0;
            for(let index = 0; index < parts.length; index += 1){
                if (already_sent.has(index)) continue;
                if (sent_any) await this.throttle(record.session_id);
                await this.sender({
                    user_id: record.user_id,
                    text: parts[index],
                    client_id: `${record.client_id}#${index}`,
                    ...send_token === undefined ? {} : {
                        context_token: send_token
                    }
                });
                await this.store.mark_outbox_part_sent(record.outbound_id, index);
                sent_any = true;
            }
            await this.store.mark_outbox_sent(record.outbound_id);
            this.paused_until = 0;
            this.rate_limit_streak = 0;
            done({
                outcome: 'sent'
            });
            return true;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const retryable = this.classify_retryable(error);
            const rate_limited = error?.rate_limited === true;
            const attempt = record.attempt + 1;
            if (rate_limited) {
                const is_notice = record.turn === undefined;
                if (is_notice) {
                    const park_ms = this.parked_retention_ms;
                    await this.store.mark_outbox_failed(record.outbound_id, 'failed_retryable', '会话窗口已关闭：已停放，等用户询问时返回', Date.now() + park_ms);
                    await this.store.prune_parked_results(park_ms);
                    done({
                        outcome: 'notice_parked',
                        error: detail,
                        attempt,
                        park_ms
                    });
                    probe('outbound', 'notice.parked', {
                        outbound_id: record.outbound_id,
                        park_ms,
                        has_token: record.context_token !== undefined
                    });
                    return true;
                }
                if (record.context_token === undefined) {
                    const defer_ms = this.no_token_defer_ms;
                    await this.store.mark_outbox_failed(record.outbound_id, 'failed_retryable', detail, Date.now() + defer_ms);
                    done({
                        outcome: 'deferred_no_token',
                        error: detail,
                        attempt,
                        defer_ms
                    });
                    probe('outbound', 'send.deferred_no_token', {
                        outbound_id: record.outbound_id,
                        kind: record.kind,
                        defer_ms
                    });
                    return true;
                }
                this.rate_limit_streak += 1;
                const cooldown = Math.min(this.rate_limit_cooldown_ms * 2 ** (this.rate_limit_streak - 1), this.rate_limit_cooldown_max_ms);
                this.paused_until = Date.now() + cooldown;
                await this.store.mark_outbox_failed(record.outbound_id, 'failed_retryable', detail, Date.now() + cooldown);
                done({
                    outcome: 'rate_limited',
                    error: detail,
                    attempt,
                    cooldown_ms: cooldown,
                    streak: this.rate_limit_streak
                });
                return false;
            }
            if (!retryable || attempt >= this.max_attempts) {
                await this.store.mark_outbox_failed(record.outbound_id, 'failed_terminal', detail);
                done({
                    outcome: 'failed_terminal',
                    error: detail,
                    attempt
                });
                probe('outbound', 'send.gave_up', {
                    outbound_id: record.outbound_id,
                    kind: record.kind,
                    attempt,
                    error: detail
                });
                return true;
            }
            const base = this.retry_base_ms;
            const next_retry_at = Date.now() + base * 2 ** Math.min(attempt, 6);
            await this.store.mark_outbox_failed(record.outbound_id, 'failed_retryable', detail, next_retry_at);
            done({
                outcome: 'failed_retryable',
                error: detail,
                attempt,
                next_retry_in_ms: next_retry_at - Date.now()
            });
            return false;
        }
    }
    begin_turn(session_id, turn) {
        this.clear_progress(session_id);
        const state = {
            turn,
            last_visible_at: Date.now(),
            heartbeats: 0,
            active: true
        };
        if (this.heartbeat_idle_ms > 0) {
            state.timer = setInterval(()=>{
                void this.maybe_heartbeat(session_id);
            }, Math.max(5_000, Math.floor(this.heartbeat_idle_ms / 3)));
            state.timer.unref?.();
        }
        this.progress.set(session_id, state);
        probe('outbound', 'turn.begin', {
            session_id,
            turn,
            heartbeat_idle_ms: this.heartbeat_idle_ms
        });
    }
    note_visible(session_id) {
        const state = this.progress.get(session_id);
        if (state !== undefined) state.last_visible_at = Date.now();
    }
    end_turn(session_id) {
        this.clear_progress(session_id);
        probe('outbound', 'turn.end', {
            session_id
        });
    }
    async maybe_heartbeat(session_id) {
        const state = this.progress.get(session_id);
        if (state === undefined || !state.active) return;
        const idle = Date.now() - state.last_visible_at;
        if (idle < this.heartbeat_idle_ms) return;
        if (state.heartbeats >= this.heartbeat_max_per_turn) {
            this.clear_progress(session_id);
            return;
        }
        const context = this.turn_context.resolve(session_id, state.turn);
        if (context === undefined) return;
        state.heartbeats += 1;
        state.last_visible_at = Date.now();
        this.store.enqueue_outbox({
            session_id,
            user_id: context.user_id,
            kind: 'heartbeat',
            text: `（还在处理中，已等待约 ${Math.round(idle / 1000)} 秒…）`,
            turn: state.turn,
            ...context.context_token === undefined ? {} : {
                context_token: context.context_token
            }
        });
        probe('outbound', 'heartbeat.enqueued', {
            session_id,
            turn: state.turn,
            idle_ms: idle,
            count: state.heartbeats
        });
        await this.drain();
    }
    enqueue_progress(session_id, text) {
        const state = this.progress.get(session_id);
        if (state === undefined) return;
        const context = this.turn_context.resolve(session_id, state.turn);
        if (context === undefined) return;
        this.note_visible(session_id);
        const record = this.store.enqueue_outbox({
            session_id,
            user_id: context.user_id,
            kind: 'progress',
            text,
            turn: state.turn,
            ...context.context_token === undefined ? {} : {
                context_token: context.context_token
            }
        });
        if (record instanceof Promise) void record;
    }
    async enqueue_assistant_async(input) {
        if (!input.text.trim()) return;
        const context = await this.turn_context.resolve_async(input.session_id, input.turn);
        const record = await this.store.enqueue_outbox({
            session_id: input.session_id,
            user_id: context?.user_id ?? input.user_id,
            kind: 'assistant',
            text: input.text,
            turn: input.turn,
            ...context?.context_token === undefined ? {} : {
                context_token: context.context_token
            }
        });
        ObservationRecorder.bind_outbound(record.outbound_id, input.session_id, input.turn);
        await Promise.resolve(this.record_entry?.({
            id: record.outbound_id,
            ts: record.created_at,
            role: 'assistant',
            text: input.text,
            user_id: record.user_id,
            session_id: record.session_id,
            turn: input.turn
        }));
    }
    async enqueue_notice_async(input) {
        if (!input.text.trim()) return;
        if (input.turn === undefined) await this.store.trim_pending_notices(input.session_id);
        const fallback_token = input.context_token ?? await this.turn_context.latest_token_if_fresh_async(input.session_id);
        await this.store.enqueue_outbox({
            session_id: input.session_id,
            user_id: input.user_id,
            kind: input.kind,
            text: input.text,
            ...input.turn === undefined ? {} : {
                turn: input.turn
            },
            ...fallback_token === undefined ? {} : {
                context_token: fallback_token
            }
        });
    }
    async enqueue_progress_async(session_id, text) {
        const state = this.progress.get(session_id);
        if (state === undefined) return;
        const context = await this.turn_context.resolve_async(session_id, state.turn);
        if (context === undefined) return;
        this.note_visible(session_id);
        await this.store.enqueue_outbox({
            session_id,
            user_id: context.user_id,
            kind: 'progress',
            text,
            turn: state.turn,
            ...context.context_token === undefined ? {} : {
                context_token: context.context_token
            }
        });
    }
    clear_progress(session_id) {
        const state = this.progress.get(session_id);
        if (state?.timer !== undefined) clearInterval(state.timer);
        this.progress.delete(session_id);
    }
    stop() {
        this.stopped = true;
        if (this.pause_timer !== undefined) {
            clearTimeout(this.pause_timer);
            this.pause_timer = undefined;
        }
        for (const session_id of [
            ...this.progress.keys()
        ])this.clear_progress(session_id);
        probe('outbound', 'stopped');
    }
    async recover_pending() {
        const pending = await this.store.list_pending_outbox();
        const now = Date.now();
        const stale_ms = Number(process.env.DSH_WEIXIN_OUTBOX_STALE_MS ?? String(10 * 60_000));
        const reply_stale_ms = Number(process.env.DSH_WEIXIN_REPLY_STALE_MS ?? String(30 * 60_000));
        let dropped = 0;
        for (const record of pending){
            const limit = record.turn === undefined ? Math.max(stale_ms, this.parked_retention_ms) : Math.max(stale_ms, reply_stale_ms);
            if (now - record.created_at > limit) {
                await this.store.mark_outbox_failed(record.outbound_id, 'failed_terminal', '重启恢复：超过补发时限，已丢弃');
                dropped += 1;
                continue;
            }
            if (record.status === 'sending') {
                await this.store.mark_outbox_failed(record.outbound_id, 'failed_retryable', '重启恢复：上次发送中断');
            }
        }
        probe('outbound', 'recover.pending', {
            count: pending.length,
            dropped_stale: dropped
        });
        return pending.length;
    }
}
