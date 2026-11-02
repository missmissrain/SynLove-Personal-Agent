import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { probe } from '../diagnostics/probe.js';
export class OpencodeWatcher {
    store;
    push;
    poll_ms;
    data_dir;
    summary_limit;
    idle_ms;
    timer;
    sweeping = false;
    seeded = false;
    constructor(options){
        this.store = options.store;
        this.push = options.push;
        this.poll_ms = options.poll_ms ?? Number(process.env.DSH_OPENCODE_WATCH_MS ?? '10000');
        this.data_dir = options.data_dir ?? process.env.OPENCODE_DATA_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.local', 'share', 'opencode');
        this.summary_limit = options.summary_limit ?? Number(process.env.DSH_OPENCODE_SUMMARY_LIMIT ?? '1800');
        this.idle_ms = options.idle_ms ?? Number(process.env.DSH_OPENCODE_IDLE_MS ?? '8000');
    }
    start() {
        if (this.timer !== undefined) return;
        const timer = setInterval(()=>{
            void this.sweep();
        }, this.poll_ms);
        timer.unref?.();
        this.timer = timer;
        probe('opencode-watch', 'start', {
            poll_ms: this.poll_ms,
            data_dir: this.data_dir
        });
        void this.sweep();
    }
    stop() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        probe('opencode-watch', 'stop');
    }
    async sweep_once() {
        await this.sweep();
    }
    async sweep() {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            const db_path = join(this.data_dir, 'opencode.db');
            if (!existsSync(db_path)) return;
            const sessions = this.read_recent_sessions(db_path);
            for (const session of sessions){
                if (Date.now() - session.time_updated < this.idle_ms) continue;
                if (await this.within_bridge_window(session.time_created)) {
                    probe('opencode-watch', 'skip_bridge_session', {
                        session_id: session.id
                    });
                    continue;
                }
                const last = this.last_assistant_message(db_path, session.id);
                if (last === undefined) continue;
                const key = 'oc_done:' + session.id;
                if (await this.store.get_meta(key) === last.message_id) continue;
                await this.store.set_meta(key, last.message_id);
                if (!this.seeded) continue;
                const text = last.text;
                if (text.trim() === '') continue;
                const task = this.last_user_text(db_path, session.id) || session.title;
                if (task.startsWith('[SynLoveTask:')) continue;
                const name = session.directory.split(/[\\/]/).filter(Boolean).pop() ?? session.directory;
                const body = [
                    'opencode 任务完成',
                    `项目：${name}`,
                    `任务：${task.slice(0, 80)}`,
                    '',
                    '结果：',
                    text.slice(0, this.summary_limit)
                ].join('\n');
                probe('opencode-watch', 'notify', {
                    session_id: session.id
                });
                for (const user_id of (await this.store.list_users()))await this.push(user_id, body);
            }
            this.seeded = true;
        } catch (error) {
            probe('opencode-watch', 'sweep_failed', {
                error: String(error)
            });
        } finally{
            this.sweeping = false;
        }
    }
    async within_bridge_window(created_at) {
        const raw = await this.store.get_meta('oc_bridge_window');
        if (raw === undefined || raw === '') return false;
        try {
            const window = JSON.parse(raw);
            const start = window.start ?? 0;
            const end = window.end ?? 0;
            return created_at >= start - 2_000 && (end === 0 || created_at <= end + 15_000);
        } catch  {
            return false;
        }
    }
    read_recent_sessions(db_path, limit = 10) {
        let db;
        try {
            db = new DatabaseSync(db_path, {
                readOnly: true
            });
            const rows = db.prepare('SELECT id, directory, title, time_created, time_updated FROM session ' + 'WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?').all(limit);
            return rows;
        } catch (error) {
            probe('opencode-watch', 'db_failed', {
                error: String(error)
            });
            return [];
        } finally{
            try {
                db?.close();
            } catch  {}
        }
    }
    last_assistant_message(db_path, session_id) {
        let db;
        try {
            db = new DatabaseSync(db_path, {
                readOnly: true
            });
            const message = db.prepare('SELECT id FROM message WHERE session_id = ? AND data LIKE \'%"role":"assistant"%\' ' + 'ORDER BY rowid DESC LIMIT 1').get(session_id);
            if (message === undefined) return undefined;
            const rows = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY rowid ASC').all(message.id);
            const texts = [];
            for (const row of rows){
                try {
                    const part = JSON.parse(row.data);
                    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
                        texts.push(part.text.trim());
                        if (texts.join('\n').length > this.summary_limit) break;
                    }
                } catch  {}
            }
            if (texts.length === 0) return undefined;
            return {
                message_id: message.id,
                text: texts.join('\n')
            };
        } catch (error) {
            probe('opencode-watch', 'assistant_read_failed', {
                error: String(error)
            });
            return undefined;
        } finally{
            try {
                db?.close();
            } catch  {}
        }
    }
    last_user_text(db_path, session_id) {
        let db;
        try {
            db = new DatabaseSync(db_path, {
                readOnly: true
            });
            const rows = db.prepare('SELECT p.data FROM part p JOIN message m ON p.message_id = m.id ' + 'WHERE p.session_id = ? AND m.data LIKE \'%"role":"user"%\' ' + 'ORDER BY p.rowid DESC LIMIT 20').all(session_id);
            for (const row of rows){
                try {
                    const part = JSON.parse(row.data);
                    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
                        return part.text.trim();
                    }
                } catch  {}
            }
        } catch  {
            return '';
        } finally{
            try {
                db?.close();
            } catch  {}
        }
        return '';
    }
}
