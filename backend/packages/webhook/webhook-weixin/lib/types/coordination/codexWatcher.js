import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../diagnostics/probe.js';
export class CodexWatcher {
    store;
    push;
    poll_ms;
    codex_home;
    summary_limit;
    timer;
    sweeping = false;
    seeded = false;
    constructor(options){
        this.store = options.store;
        this.push = options.push;
        this.poll_ms = options.poll_ms ?? Number(process.env.DSH_CODEX_WATCH_MS ?? '8000');
        this.codex_home = options.codex_home ?? process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.codex');
        this.summary_limit = options.summary_limit ?? Number(process.env.DSH_CODEX_SUMMARY_LIMIT ?? '1800');
    }
    start() {
        if (this.timer !== undefined) return;
        const timer = setInterval(()=>{
            void this.sweep();
        }, this.poll_ms);
        timer.unref?.();
        this.timer = timer;
        probe('codex-watch', 'start', {
            poll_ms: this.poll_ms,
            codex_home: this.codex_home
        });
        void this.sweep();
    }
    stop() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        probe('codex-watch', 'stop');
    }
    async sweep() {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            const statuses = this.read_statuses();
            if (statuses.length === 0) return;
            for (const item of statuses){
                if (item.title.startsWith('[SynLoveTask:')) continue;
                const key = 'codex_watch:' + item.thread_id;
                const signature = `${item.status}|${item.event_at ?? ''}`;
                const previous = await this.store.get_meta(key);
                if (previous === signature) continue;
                await this.store.set_meta(key, signature);
                if (!this.seeded) continue;
                if (item.status !== '已完成' && item.status !== '已中止') continue;
                const text = this.compose(item);
                probe('codex-watch', 'notify', {
                    thread_id: item.thread_id,
                    status: item.status,
                    event_at: item.event_at
                });
                for (const user_id of (await this.store.list_users()))await this.push(user_id, text);
            }
            this.seeded = true;
        } catch (error) {
            probe('codex-watch', 'sweep_failed', {
                error: String(error)
            });
        } finally{
            this.sweeping = false;
        }
    }
    compose(item) {
        const summary = item.status === '已中止' ? '（任务被中止）' : this.latest_assistant_text(item.rollout_path).slice(0, this.summary_limit);
        const name = item.workspace.split(/[\\/]/).filter(Boolean).pop() ?? item.workspace;
        return [
            `Codex 任务${item.status}`,
            `项目：${name}`,
            `任务：${item.title.slice(0, 80)}`,
            '',
            '结果：',
            summary || '（没有取到结果文本）'
        ].join('\n');
    }
    read_statuses(limit = 8) {
        const state_path = join(this.codex_home, 'state_5.sqlite');
        if (!existsSync(state_path)) return [];
        let db;
        try {
            db = new DatabaseSync(state_path, {
                readOnly: true
            });
            const rows = db.prepare("SELECT id, rollout_path, cwd, title, updated_at FROM threads " + "WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?").all(limit);
            return rows.map((row)=>{
                const rollout = String(row.rollout_path ?? '');
                const { status, event_at } = this.read_lifecycle(rollout);
                return {
                    thread_id: String(row.id),
                    rollout_path: rollout,
                    workspace: normalize_path(String(row.cwd ?? '')),
                    title: this.latest_user_message(rollout) || String(row.title ?? '未命名任务'),
                    status,
                    ...event_at === undefined ? {} : {
                        event_at
                    }
                };
            });
        } catch (error) {
            probe('codex-watch', 'state_db_failed', {
                error: String(error)
            });
            return [];
        } finally{
            try {
                db?.close();
            } catch  {}
        }
    }
    read_lifecycle(rollout_path) {
        if (!rollout_path || !existsSync(rollout_path)) return {
            status: '记录缺失'
        };
        const patterns = [
            [
                '"type":"task_complete"',
                '已完成'
            ],
            [
                '"type":"turn_aborted"',
                '已中止'
            ],
            [
                '"type":"task_started"',
                '运行中'
            ]
        ];
        try {
            const size = statSync(rollout_path).size;
            const block = 512 * 1024;
            const handle = readFileSync(rollout_path);
            const tail = handle.subarray(Math.max(0, size - block)).toString('utf8');
            const lines = tail.split('\n');
            for(let i = lines.length - 1; i >= 0; i -= 1){
                const line = lines[i];
                for (const [marker, status] of patterns){
                    if (!line.includes(marker)) continue;
                    const at = line.match(/"timestamp":"([^"]+)"/);
                    return {
                        status,
                        ...at === null ? {} : {
                            event_at: at[1]
                        }
                    };
                }
            }
        } catch (error) {
            probe('codex-watch', 'rollout_read_failed', {
                error: String(error),
                rollout_path
            });
        }
        return {
            status: '等待首次运行'
        };
    }
    latest_user_message(rollout_path) {
        return this.scan_tail(rollout_path, (line)=>{
            if (!line.includes('"type":"user_message"')) return undefined;
            try {
                const parsed = JSON.parse(line);
                const message = String(parsed.payload?.message ?? '').trim();
                return clean_user_message(message) || undefined;
            } catch  {
                return undefined;
            }
        }) ?? '';
    }
    latest_assistant_text(rollout_path) {
        let latest = '';
        try {
            const text = readFileSync(rollout_path, 'utf8');
            for (const line of text.split('\n')){
                if (!line.includes('"role":"assistant"')) continue;
                try {
                    const parsed = JSON.parse(line);
                    const payload = parsed.payload;
                    if (parsed.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'assistant') continue;
                    const parts = (payload.content ?? []).map((part)=>part.text ?? part.output_text ?? '').filter((item)=>item.length > 0);
                    if (parts.length > 0) latest = parts.join('\n').trim();
                } catch  {
                    continue;
                }
            }
        } catch (error) {
            probe('codex-watch', 'assistant_read_failed', {
                error: String(error)
            });
        }
        return latest;
    }
    scan_tail(rollout_path, pick) {
        if (!existsSync(rollout_path)) return undefined;
        try {
            const size = statSync(rollout_path).size;
            const block = 1024 * 1024;
            const data = readFileSync(rollout_path);
            const tail = data.subarray(Math.max(0, size - block)).toString('utf8');
            const lines = tail.split('\n');
            for(let i = lines.length - 1; i >= 0; i -= 1){
                const value = pick(lines[i]);
                if (value !== undefined) return value;
            }
        } catch  {
            return undefined;
        }
        return undefined;
    }
}
function clean_user_message(message) {
    const marker = '## My request for Codex:';
    let text = message;
    if (text.includes(marker)) text = text.slice(text.indexOf(marker) + marker.length);
    text = text.trim();
    if (text.startsWith('<environment_context>') || text.startsWith('<permissions instructions>')) return '';
    return text;
}
function normalize_path(path) {
    return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}
export function list_recent_rollouts(codex_home, limit = 5) {
    const root = join(codex_home, 'sessions');
    if (!existsSync(root)) return [];
    const found = [];
    const walk = (dir, depth = 0)=>{
        if (depth > 4) return;
        for (const entry of readdirSync(dir, {
            withFileTypes: true
        })){
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (entry.name.endsWith('.jsonl')) found.push({
                path: full,
                mtime: statSync(full).mtimeMs
            });
        }
    };
    walk(root);
    return found.sort((a, b)=>b.mtime - a.mtime).slice(0, limit).map((item)=>item.path);
}
