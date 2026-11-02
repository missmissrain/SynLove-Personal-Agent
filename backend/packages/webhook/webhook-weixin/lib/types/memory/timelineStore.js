import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../diagnostics/probe.js';
import { rename_with_retry, with_file_lock } from './fileLock.js';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const INDEX_VERSION = 1;
export class TimelineStore {
    dir;
    days_dir;
    timezone;
    persist_reasoning;
    idle_ms;
    id_cache = new Map();
    dirty_views = new Set();
    tmp_seq = 0;
    rebuilding_index = false;
    meta_cache = new Map();
    constructor(options){
        this.dir = options.dir;
        this.days_dir = join(this.dir, 'days');
        this.timezone = options.timezone ?? DEFAULT_TIMEZONE;
        this.persist_reasoning = options.persist_reasoning ?? process.env.DSH_TIMELINE_PERSIST_REASONING === '1';
        this.idle_ms = options.idle_ms ?? Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? '3')) * 3_600_000;
        this.ensure_dirs();
    }
    dir_path() {
        return this.dir;
    }
    ensure_dirs() {
        mkdirSync(this.days_dir, {
            recursive: true
        });
    }
    forget_caches() {
        this.id_cache.clear();
        this.meta_cache.clear();
        probe('timeline', 'caches.forgotten', {});
    }
    append(entry) {
        this.ensure_dirs();
        const date = this.day_key(entry.ts);
        const path = this.entries_path(date);
        const record = this.persist_reasoning ? entry : {
            ...entry,
            reasoning: undefined
        };
        const line = JSON.stringify(strip_undefined(record));
        const written = with_file_lock(path, ()=>{
            const ids = this.known_ids(date);
            if (ids.has(entry.id)) {
                probe('timeline', 'append.duplicate', {
                    date,
                    id: entry.id
                });
                return false;
            }
            const base = this.base_meta(date);
            appendFileSync(path, `${line}\n`, 'utf8');
            ids.add(entry.id);
            this.set_meta(date, increment_meta(base, entry));
            this.dirty_views.add(date);
            return true;
        });
        if (written) {
            this.regenerate_view_if_due(date);
            probe('timeline', 'append.ok', {
                date,
                role: entry.role,
                id: entry.id,
                chars: entry.text.length
            });
        }
        return written;
    }
    known_ids(date) {
        const path = this.entries_path(date);
        const stat = existsSync(path) ? statSync(path) : undefined;
        const key = stat === undefined ? 'missing' : `${stat.size}:${stat.mtimeMs}`;
        const cached = this.id_cache.get(date);
        if (cached !== undefined && cached.key === key) return cached.ids;
        const ids = new Set(this.read_entries(date).map((item)=>item.id));
        this.id_cache.set(date, {
            key,
            ids
        });
        return ids;
    }
    base_meta(date) {
        const cached = this.meta_cache.get(date);
        if (cached !== undefined) return cached;
        const entries = this.read_entries(date);
        const meta = this.meta_from_entries(date, entries);
        this.meta_cache.set(date, meta);
        return meta;
    }
    set_meta(date, meta) {
        this.meta_cache.set(date, meta);
        const index = this.load_index();
        this.save_index({
            ...index,
            days: {
                ...index.days,
                [date]: meta
            }
        });
    }
    meta_from_entries(date, entries) {
        const ts = entries.map((item)=>item.ts);
        return strip_undefined({
            date,
            timezone: this.timezone,
            entries: entries.length,
            user_entries: entries.filter((item)=>item.role === 'user').length,
            assistant_entries: entries.filter((item)=>item.role === 'assistant').length,
            first_ts: ts.length === 0 ? undefined : Math.min(...ts),
            last_ts: ts.length === 0 ? undefined : Math.max(...ts),
            updated_at: Date.now()
        });
    }
    regenerate_view_if_due(date) {
        if (!this.dirty_views.has(date)) return;
        const path = this.view_path(date);
        const stat = existsSync(path) ? statSync(path) : undefined;
        if (stat !== undefined && Date.now() - stat.mtimeMs < 5_000) return;
        this.regenerate_view(date);
        this.dirty_views.delete(date);
    }
    flush_views() {
        for (const date of [
            ...this.dirty_views
        ]){
            this.regenerate_view(date);
            this.dirty_views.delete(date);
        }
    }
    append_many(entries) {
        let written = 0;
        for (const entry of entries){
            if (this.append(entry)) written += 1;
        }
        return written;
    }
    update_entry(date, entry_id, patch) {
        assert_day_key(date);
        const path = this.entries_path(date);
        return with_file_lock(path, ()=>{
            const entries = this.read_entries(date);
            const index = entries.findIndex((item)=>item.id === entry_id);
            if (index < 0) {
                probe('timeline', 'entry.update_miss', {
                    date,
                    id: entry_id
                });
                return false;
            }
            const current = entries[index];
            const next = strip_undefined({
                ...current,
                ...patch.text === undefined ? {} : {
                    text: patch.text
                },
                ...patch.attachments === undefined ? {} : {
                    attachments: patch.attachments
                }
            });
            entries[index] = next;
            this.write_atomic(path, `${entries.map((item)=>JSON.stringify(strip_undefined(item))).join('\n')}\n`);
            this.refresh_meta(date);
            this.regenerate_view(date);
            this.dirty_views.delete(date);
            probe('timeline', 'entry.updated', {
                date,
                id: entry_id,
                attachments: patch.attachments?.length
            });
            return true;
        });
    }
    update_attachment_description(date, entry_id, attachment_id, description) {
        const entry = this.read_entries(date).find((item)=>item.id === entry_id);
        if (entry?.attachments === undefined) return false;
        const next = entry.attachments.map((item)=>item.id === attachment_id ? strip_undefined({
                ...item,
                description
            }) : item);
        if (!next.some((item, i)=>item.description !== entry.attachments?.[i]?.description)) return false;
        return this.update_entry(date, entry_id, {
            attachments: next
        });
    }
    update_summary(date, summary, meta) {
        assert_day_key(date);
        this.write_atomic(this.summary_path(date), summary.trim() === '' ? '' : `${summary.trim()}\n`);
        const index = this.load_index();
        const current = index.days[date] ?? this.empty_meta(date);
        const next = strip_undefined({
            ...current,
            summary_updated_at: Date.now(),
            summary_model: meta?.model ?? current.summary_model,
            updated_at: Date.now()
        });
        this.save_index({
            ...index,
            days: {
                ...index.days,
                [date]: next
            }
        });
        this.regenerate_view(date);
        this.dirty_views.delete(date);
        probe('timeline', 'summary.updated', {
            date,
            chars: summary.length,
            model: meta?.model
        });
    }
    regenerate_view(date) {
        assert_day_key(date);
        const entries = this.read_entries(date);
        const meta = this.meta_for(date, entries);
        const summary = this.read_summary(date);
        this.write_atomic(this.view_path(date), render_view(meta, summary, entries));
    }
    rebuild_index() {
        const dates = existsSync(this.days_dir) ? readdirSync(this.days_dir).filter((name)=>name.endsWith('.jsonl')).map((name)=>name.slice(0, -'.jsonl'.length)).sort() : [];
        const days = {};
        for (const date of dates)days[date] = this.meta_for(date, this.read_entries(date));
        this.save_index({
            version: INDEX_VERSION,
            timezone: this.timezone,
            updated_at: Date.now(),
            days
        });
        this.id_cache.clear();
        this.meta_cache.clear();
        for (const [date, meta] of Object.entries(days))this.meta_cache.set(date, meta);
        probe('timeline', 'index.rebuilt', {
            days: dates.length
        });
        return dates.length;
    }
    days_needing_summary(now = Date.now()) {
        const index = this.load_index();
        const out = [];
        for (const meta of Object.values(index.days)){
            if (meta.entries === 0 || meta.last_ts === undefined) continue;
            if (now - meta.last_ts < this.idle_ms) continue;
            const summarized_at = meta.summary_updated_at ?? 0;
            if (summarized_at >= meta.last_ts) continue;
            out.push(meta.date);
        }
        return out.sort();
    }
    async summarize_day(date, summarize) {
        assert_day_key(date);
        const entries = this.read_entries(date);
        if (entries.length === 0) return undefined;
        const previous = this.read_summary(date);
        const result = await summarize({
            date,
            timezone: this.timezone,
            entries,
            ...previous === undefined ? {} : {
                previous_summary: previous
            }
        });
        const text = result.text.trim();
        if (text === '') return undefined;
        this.update_summary(date, text, {
            ...result.model === undefined ? {} : {
                model: result.model
            }
        });
        return text;
    }
    async summarize_due(summarize, now = Date.now()) {
        const done = [];
        for (const date of this.days_needing_summary(now)){
            try {
                const text = await this.summarize_day(date, summarize);
                if (text !== undefined) done.push(date);
            } catch (error) {
                probe('timeline', 'summary.failed', {
                    date,
                    error: String(error)
                });
            }
        }
        return done;
    }
    read_day(date, filter) {
        assert_day_key(date);
        const all = this.read_entries(date);
        const entries = filter === undefined ? all : all.filter((item)=>match_filter(item, filter));
        const summary = this.read_summary(date);
        return {
            meta: this.meta_for(date, entries),
            ...summary === undefined ? {} : {
                summary
            },
            entries
        };
    }
    read_range(from, to) {
        const end = to ?? from;
        assert_day_key(from);
        assert_day_key(end);
        return this.list_days().map((meta)=>meta.date).filter((date)=>date >= from && date <= end).map((date)=>this.read_day(date));
    }
    list_days() {
        const index = this.load_index();
        return Object.values(index.days).sort((a, b)=>a.date.localeCompare(b.date));
    }
    read_summary(date) {
        const path = this.summary_path(date);
        if (!existsSync(path)) return undefined;
        const text = readFileSync(path, 'utf8').trim();
        return text === '' ? undefined : text;
    }
    search(keyword, options) {
        const needle = keyword.trim().toLowerCase();
        if (needle === '') return [];
        const limit = options?.limit ?? 50;
        const filter = {
            ...options?.user_id === undefined ? {} : {
                user_id: options.user_id
            },
            ...options?.session_id === undefined ? {} : {
                session_id: options.session_id
            }
        };
        const hits = [];
        const dates = this.list_days().map((meta)=>meta.date).reverse();
        for (const date of dates){
            if (options?.from !== undefined && date < options.from) continue;
            if (options?.to !== undefined && date > options.to) continue;
            for (const entry of this.read_entries(date)){
                if (!match_filter(entry, filter)) continue;
                if (entry.text.toLowerCase().includes(needle)) hits.push({
                    date,
                    entry
                });
                if (hits.length >= limit) return hits;
            }
        }
        return hits;
    }
    stats() {
        const days = this.list_days();
        return strip_undefined({
            days: days.length,
            entries: days.reduce((sum, meta)=>sum + meta.entries, 0),
            first_date: days[0]?.date,
            last_date: days[days.length - 1]?.date
        });
    }
    day_key(ts) {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: this.timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date(ts));
    }
    entries_path(date) {
        return join(this.days_dir, `${date}.jsonl`);
    }
    summary_path(date) {
        return join(this.days_dir, `${date}.summary.md`);
    }
    view_path(date) {
        return join(this.days_dir, `${date}.md`);
    }
    index_path() {
        return join(this.dir, 'index.json');
    }
    read_entries(date) {
        const path = this.entries_path(date);
        if (!existsSync(path)) return [];
        const out = [];
        for (const line of readFileSync(path, 'utf8').split('\n')){
            const trimmed = line.trim();
            if (trimmed === '') continue;
            try {
                out.push(JSON.parse(trimmed));
            } catch  {
                probe('timeline', 'entries.bad_line', {
                    date
                });
            }
        }
        return out;
    }
    meta_for(date, entries) {
        const index = this.load_index();
        const stored = index.days[date];
        const ts = entries.map((entry)=>entry.ts);
        return strip_undefined({
            date,
            timezone: this.timezone,
            entries: entries.length,
            user_entries: entries.filter((entry)=>entry.role === 'user').length,
            assistant_entries: entries.filter((entry)=>entry.role === 'assistant').length,
            first_ts: ts.length === 0 ? undefined : Math.min(...ts),
            last_ts: ts.length === 0 ? undefined : Math.max(...ts),
            updated_at: stored?.updated_at ?? Date.now(),
            summary_updated_at: stored?.summary_updated_at,
            summary_model: stored?.summary_model
        });
    }
    empty_meta(date) {
        return {
            date,
            timezone: this.timezone,
            entries: 0,
            user_entries: 0,
            assistant_entries: 0,
            updated_at: Date.now()
        };
    }
    refresh_meta(date) {
        const index = this.load_index();
        const entries = this.read_entries(date);
        const next = strip_undefined({
            ...this.meta_from_entries(date, entries),
            summary_updated_at: index.days[date]?.summary_updated_at,
            summary_model: index.days[date]?.summary_model
        });
        this.meta_cache.set(date, next);
        this.save_index({
            ...index,
            days: {
                ...index.days,
                [date]: next
            }
        });
    }
    load_index() {
        const path = this.index_path();
        if (!existsSync(path)) return this.rebuild_from_disk();
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            if (parsed.version !== INDEX_VERSION || typeof parsed.days !== 'object' || parsed.days === null) {
                probe('timeline', 'index.invalid_shape', {
                    path
                });
                return this.rebuild_from_disk();
            }
            return parsed;
        } catch  {
            probe('timeline', 'index.corrupt', {
                path
            });
            return this.rebuild_from_disk();
        }
    }
    rebuild_from_disk() {
        const empty = {
            version: INDEX_VERSION,
            timezone: this.timezone,
            updated_at: Date.now(),
            days: {}
        };
        if (this.rebuilding_index) return empty;
        this.rebuilding_index = true;
        try {
            this.rebuild_index();
        } catch (error) {
            probe('timeline', 'index.rebuild_failed', {
                error: String(error)
            });
            return empty;
        } finally{
            this.rebuilding_index = false;
        }
        try {
            return JSON.parse(readFileSync(this.index_path(), 'utf8'));
        } catch  {
            return empty;
        }
    }
    save_index(index) {
        this.write_atomic(this.index_path(), `${JSON.stringify({
            ...index,
            updated_at: Date.now()
        }, null, 2)}\n`);
    }
    write_atomic(path, content) {
        this.tmp_seq += 1;
        const tmp = `${path}.tmp-${process.pid}-${this.tmp_seq}`;
        writeFileSync(tmp, content, 'utf8');
        rename_with_retry(tmp, path);
    }
}
function increment_meta(base, entry) {
    return strip_undefined({
        ...base,
        entries: base.entries + 1,
        user_entries: base.user_entries + (entry.role === 'user' ? 1 : 0),
        assistant_entries: base.assistant_entries + (entry.role === 'assistant' ? 1 : 0),
        first_ts: base.first_ts === undefined ? entry.ts : Math.min(base.first_ts, entry.ts),
        last_ts: base.last_ts === undefined ? entry.ts : Math.max(base.last_ts, entry.ts),
        updated_at: Date.now()
    });
}
function match_filter(entry, filter) {
    if (filter.user_id !== undefined && entry.user_id !== filter.user_id) return false;
    if (filter.session_id !== undefined && entry.session_id !== filter.session_id) return false;
    return true;
}
function assert_day_key(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`非法的日期键：${date}（应为 YYYY-MM-DD）`);
}
function strip_undefined(value) {
    const out = {};
    for (const [key, item] of Object.entries(value)){
        if (item !== undefined) out[key] = item;
    }
    return out;
}
function render_view(meta, summary, entries) {
    const lines = [];
    lines.push('---');
    lines.push(`date: ${meta.date}`);
    lines.push(`timezone: ${meta.timezone}`);
    lines.push(`entries: ${meta.entries}`);
    lines.push(`user_entries: ${meta.user_entries}`);
    lines.push(`assistant_entries: ${meta.assistant_entries}`);
    if (meta.first_ts !== undefined) lines.push(`first_at: ${iso(meta.first_ts, meta.timezone)}`);
    if (meta.last_ts !== undefined) lines.push(`last_at: ${iso(meta.last_ts, meta.timezone)}`);
    lines.push(`updated_at: ${iso(meta.updated_at, meta.timezone)}`);
    if (meta.summary_updated_at !== undefined) lines.push(`summary_updated_at: ${iso(meta.summary_updated_at, meta.timezone)}`);
    if (meta.summary_model !== undefined) lines.push(`summary_model: ${meta.summary_model}`);
    lines.push('---');
    lines.push('');
    lines.push(`# ${meta.date}`);
    lines.push('');
    lines.push('## 摘要');
    lines.push('');
    lines.push('<!-- 权威来源：同目录 <date>.summary.md；本文件是生成视图，勿手改。 -->');
    lines.push('');
    lines.push(summary ?? '（尚未生成）');
    lines.push('');
    lines.push('## 记录');
    lines.push('');
    lines.push('<!-- 权威来源：同目录 <date>.jsonl；本文件是生成视图，勿手改。 -->');
    lines.push('');
    for (const entry of entries){
        lines.push(`### ${clock(entry.ts, meta.timezone)} · ${entry.role === 'user' ? '用户' : '欣爱'}`);
        lines.push('');
        if (entry.text.trim() !== '') lines.push(entry.text.trim());
        for (const item of entry.attachments ?? []){
            const size = item.bytes === undefined ? '' : `（${Math.round(item.bytes / 1024)}KB）`;
            const dims = item.width !== undefined && item.height !== undefined ? ` ${item.width}×${item.height}` : '';
            lines.push(`- [${item.media_type}]${dims}${size} 附件 ${item.id}${item.name === undefined ? '' : ` · ${item.name}`}`);
            if (item.description !== undefined) lines.push(`  - 内容：${item.description}`);
        }
        lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}
function clock(ts, timezone) {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date(ts));
}
function iso(ts, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date(ts));
    const offset = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'longOffset'
    }).formatToParts(new Date(ts)).find((part)=>part.type === 'timeZoneName')?.value ?? 'GMT';
    const zone = offset === 'GMT' ? '+00:00' : offset.replace('GMT', '');
    return `${parts.replace(', ', 'T').replace(/\//g, '-')}${zone}`;
}
