import { appendFile } from 'node:fs/promises';
import { ObservationRecorder } from '@deepseek-ai/dsh-llm';
function probe_path() {
    const path = process.env.DSH_WEIXIN_PROBE_LOG;
    return path !== undefined && path.length > 0 ? path : undefined;
}
export function probe_enabled() {
    return probe_path() !== undefined;
}
export function probe(scope, event, fields) {
    const path = probe_path();
    if (path === undefined) return;
    const session_id = typeof fields?.session_id === 'string' ? fields.session_id : undefined;
    const trace = typeof fields?.outbound_id === 'string' ? ObservationRecorder.outbound_context(fields.outbound_id) : session_id === undefined ? undefined : typeof fields?.turn === 'number' ? ObservationRecorder.turn_context(session_id, fields.turn) : ObservationRecorder.current(session_id);
    if (trace && !event.startsWith('poll.')) {
        ObservationRecorder.emit({
            traceId: trace.traceId,
            parentSpanId: trace.spanId,
            sessionId: session_id,
            kind: 'transport',
            phase: 'event',
            name: `${scope}.${event}`,
            deliveryId: fields?.delivery_id,
            outboxId: fields?.outbound_id,
            outcome: fields?.outcome,
            durationMs: fields?.duration_ms
        });
    }
    const record = {
        at: new Date().toISOString(),
        scope,
        event,
        ...fields === undefined ? {} : {
            data: sanitize(fields)
        }
    };
    void appendFile(path, JSON.stringify(record) + '\n', 'utf8').catch(()=>undefined);
}
export function probe_timer(scope, event, fields) {
    const started = Date.now();
    return (extra)=>probe(scope, event, {
            ...fields,
            ...extra,
            duration_ms: Date.now() - started
        });
}
function sanitize(value, depth = 0) {
    if (typeof value === 'string') return value.length > 400 ? value.slice(0, 400) + `…(+${value.length - 400})` : value;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        const head = value.slice(0, 20).map((item)=>sanitize(item, depth + 1));
        return value.length > 20 ? [
            ...head,
            `…(+${value.length - 20})`
        ] : head;
    }
    if (typeof value === 'object') {
        if (depth > 3) return '[deep]';
        const out = {};
        for (const [key, item] of Object.entries(value))out[key] = sanitize(item, depth + 1);
        return out;
    }
    return String(value);
}
