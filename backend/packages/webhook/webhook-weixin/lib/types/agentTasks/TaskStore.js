import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export class TaskStore {
    db;
    constructor(path){
        mkdirSync(dirname(path), {
            recursive: true
        });
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS taskOrigins (id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS taskLease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agentTasks (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, key TEXT UNIQUE NOT NULL, origin TEXT NOT NULL,
        request TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, worker TEXT UNIQUE NOT NULL,
        result TEXT, notice TEXT, queued INTEGER NOT NULL DEFAULT 0, error TEXT,
        created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS taskPending ON agentTasks(state,queued,created);`);
        if (!this.db.prepare('PRAGMA table_info(taskLease)').all().some((row)=>row.name === 'pid')) this.db.exec('ALTER TABLE taskLease ADD COLUMN pid INTEGER NOT NULL DEFAULT 0');
    }
    save_origin(id, session, data) {
        this.db.prepare('INSERT OR IGNORE INTO taskOrigins VALUES (?,?,?)').run(id, session, JSON.stringify(data));
    }
    get_origin(id, session) {
        const row = this.db.prepare('SELECT data FROM taskOrigins WHERE id=? AND session=?').get(id, session);
        return row ? JSON.parse(row.data) : undefined;
    }
    create_task(session, key, origin, request, kind) {
        const id = randomUUID(), now = Date.now();
        this.db.prepare(`INSERT OR IGNORE INTO agentTasks
      (id,session,key,origin,request,kind,state,worker,created,updated) VALUES (?,?,?,?,?,?,'queued',?,?,?)`).run(id, session, key, JSON.stringify(origin), request, kind, `task-${id}`, now, now);
        return this.decode_row(this.db.prepare('SELECT * FROM agentTasks WHERE key=?').get(key));
    }
    get_task(id, session) {
        const row = this.db.prepare('SELECT * FROM agentTasks WHERE id=? AND session=?').get(id, session);
        if (!row) throw new Error('任务不存在或不属于当前会话');
        return this.decode_row(row);
    }
    list_tasks(session) {
        const rows = session === undefined ? this.db.prepare('SELECT * FROM agentTasks ORDER BY created').all() : this.db.prepare('SELECT * FROM agentTasks WHERE session=? ORDER BY created DESC LIMIT 20').all(session);
        return rows.map((row)=>this.decode_row(row));
    }
    pending_tasks(phase) {
        const rows = phase === 'work' ? this.db.prepare("SELECT * FROM agentTasks WHERE state='queued' ORDER BY created LIMIT 128").all() : this.db.prepare(`SELECT * FROM agentTasks WHERE queued=0
        AND state IN ('succeeded','partial','failed','cancelled','interrupted') ORDER BY created LIMIT 128`).all();
        return rows.map((row)=>this.decode_row(row));
    }
    update_task(id, patch) {
        const allow = new Set([
            'state',
            'result',
            'notice',
            'queued',
            'error'
        ]);
        const fields = Object.keys(patch);
        if (!fields.length || fields.some((key)=>!allow.has(key))) throw new Error('非法任务状态字段');
        this.db.prepare(`UPDATE agentTasks SET ${fields.map((key)=>`${key}=?`).join(',')},updated=? WHERE id=?`).run(...fields.map((key)=>patch[key]), Date.now(), id);
    }
    recover_tasks() {
        this.db.prepare(`UPDATE agentTasks SET state='interrupted',
      result='上次运行被中断，尚未重新执行；已有操作可能已经生效，需要核对后再继续。',
      updated=? WHERE state IN ('running','cancelling')`).run(Date.now());
    }
    claim_lease(owner) {
        const now = Date.now();
        const prior = this.db.prepare('SELECT * FROM taskLease WHERE id=1').get();
        if (prior && prior.owner !== owner && prior.pid > 0) {
            try {
                process.kill(prior.pid, 0);
            } catch (error) {
                if (error.code === 'ESRCH') this.db.prepare('DELETE FROM taskLease WHERE owner=? AND until=? AND pid=?').run(prior.owner, prior.until, prior.pid);
            }
        }
        return this.db.prepare(`INSERT INTO taskLease(id,owner,until,pid) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until=excluded.until,pid=excluded.pid
      WHERE taskLease.owner=excluded.owner OR taskLease.until<?`).run(owner, now + 30000, process.pid, now).changes === 1;
    }
    has_lease(owner) {
        return !!this.db.prepare('SELECT 1 FROM taskLease WHERE id=1 AND owner=? AND until>?').get(owner, Date.now());
    }
    release_lease(owner) {
        this.db.prepare('DELETE FROM taskLease WHERE owner=?').run(owner);
    }
    decode_row(row) {
        return {
            ...row,
            origin: JSON.parse(row.origin)
        };
    }
    close_store() {
        this.db.close();
    }
}
