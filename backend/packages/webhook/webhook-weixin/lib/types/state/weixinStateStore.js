import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { probe, probe_timer } from '../diagnostics/probe.js';
export const STATE_SCHEMA_VERSION = 3;
export const INFLIGHT_TURN_PREFIX = 'inflight_turn:';
export class WeixinStateStore {
    db;
    storeDir;
    closed = false;
    constructor(options){
        const create = options.create ?? true;
        this.storeDir = dirname(options.path);
        if (!create && !existsSync(options.path)) {
            throw new Error(`weixin state store 不存在且不允许创建：${options.path}`);
        }
        mkdirSync(dirname(options.path), {
            recursive: true
        });
        const done = probe_timer('state', 'store.open', {
            path: options.path
        });
        this.db = new DatabaseSync(options.path);
        try {
            this.db.exec('PRAGMA journal_mode = WAL');
            this.db.exec('PRAGMA synchronous = FULL');
            this.db.exec('PRAGMA foreign_keys = ON');
            this.migrate();
        } catch (error) {
            try {
                this.db.close();
            } catch  {}
            this.closed = true;
            throw error;
        }
        done();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transport_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS route (
        user_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery (
        delivery_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        injected_at INTEGER,
        last_error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        context_token TEXT,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS delivery_status_idx ON delivery (status, received_at);
      CREATE TABLE IF NOT EXISTS outbox (
        outbound_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        turn INTEGER,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        context_token TEXT,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        sent_parts_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS outbox_queue_idx ON outbox (status, session_id, sequence);
      CREATE TABLE IF NOT EXISTS turn_context (
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        delivery_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        context_token TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn)
      );
      CREATE TABLE IF NOT EXISTS consumer_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_started_at INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
    `);
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
        if (row === undefined) {
            this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(STATE_SCHEMA_VERSION));
            return;
        }
        const found = Number(row.value);
        if (found === STATE_SCHEMA_VERSION) return;
        if (found >= 1 && found < STATE_SCHEMA_VERSION) {
            const delivery_columns = this.column_names('delivery');
            if (!delivery_columns.includes('context_token')) {
                this.db.exec('ALTER TABLE delivery ADD COLUMN context_token TEXT');
            }
            if (!delivery_columns.includes('payload_json')) {
                this.db.exec('ALTER TABLE delivery ADD COLUMN payload_json TEXT');
            }
            const outbox_columns = this.column_names('outbox');
            if (!outbox_columns.includes('sent_parts_json')) {
                this.db.exec("ALTER TABLE outbox ADD COLUMN sent_parts_json TEXT NOT NULL DEFAULT '[]'");
            }
            this.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(STATE_SCHEMA_VERSION), 'schema_version');
            probe('state', 'schema.migrated', {
                from: found,
                to: STATE_SCHEMA_VERSION
            });
            return;
        }
        throw new Error(`weixin state store schema 版本不匹配：期望 ${STATE_SCHEMA_VERSION}，实际 ${found}。` + '拒绝自动迁移或清空，请人工处理后再启动。');
    }
    column_names(table) {
        return this.db.prepare(`PRAGMA table_info(${table})`).all().map((column)=>column.name);
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        this.db.close();
    }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch  {}
            probe('state', 'transaction.rollback', {
                error: String(error)
            });
            throw error;
        }
    }
    get_cursor() {
        const row = this.db.prepare('SELECT cursor FROM transport_cursor WHERE id = 1').get();
        return row?.cursor ?? '';
    }
    set_cursor(cursor) {
        this.db.prepare('INSERT INTO transport_cursor (id, cursor, updated_at) VALUES (1, ?, ?) ' + 'ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at').run(cursor, Date.now());
        probe('state', 'cursor.committed', {
            cursor_len: cursor.length
        });
    }
    get_meta(key) {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row?.value;
    }
    set_meta(key, value) {
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }
    list_meta_prefix(prefix) {
        return this.db.prepare('SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key').all(`${prefix}%`);
    }
    delete_meta(key) {
        this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    }
    shared_base() {
        if ((process.env.DSH_SESSION_SHARED ?? '').trim() === '') return '';
        try {
            const text = readFileSync(join(this.storeDir, 'shared-session.txt'), 'utf8');
            return (text.split('\n')[0] ?? '').trim().replace(/-c\d+$/, '') || 'main';
        } catch  {
            return 'main';
        }
    }
    persist_shared(id) {
        try {
            const file = join(this.storeDir, 'shared-session.txt');
            const current = existsSync(file) ? (readFileSync(file, 'utf8').split('\n')[0] ?? '').trim() : '';
            if (current !== id) writeFileSync(file, `${id}\n`, 'utf8');
        } catch  {}
    }
    get_session_id(user_id) {
        if (this.shared_base() !== '') return this.session_id_for(user_id);
        const row = this.db.prepare('SELECT session_id FROM route WHERE user_id = ?').get(user_id);
        return row?.session_id;
    }
    clear_queue() {
        const result = this.db.prepare("DELETE FROM outbox WHERE status IN ('pending', 'sending', 'failed_retryable')").run();
        const removed = Number(result.changes ?? 0);
        probe('state', 'outbox.cleared', {
            removed
        });
        return removed;
    }
    session_id_for(user_id) {
        const base = this.shared_base();
        if (base !== '') {
            const epoch = this.context_epoch(user_id);
            const id = epoch <= 0 ? base : `${base}-c${epoch}`;
            this.persist_shared(id);
            return id;
        }
        const epoch = this.context_epoch(user_id);
        return epoch <= 0 ? `weixin-${user_id}` : `weixin-${user_id}-c${epoch}`;
    }
    clear_session_id(user_id) {
        this.db.prepare('DELETE FROM route WHERE user_id = ?').run(user_id);
        probe('state', 'route.cleared', {
            user_id
        });
    }
    context_epoch(user_id) {
        const raw = this.get_meta(`context_epoch:${user_id}`);
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }
    bump_context_epoch(user_id) {
        const next = this.context_epoch(user_id) + 1;
        this.set_meta(`context_epoch:${user_id}`, String(next));
        probe('state', 'context.epoch_bumped', {
            user_id,
            epoch: next
        });
        return next;
    }
    set_session_id(user_id, session_id) {
        this.db.prepare('INSERT INTO route (user_id, session_id, updated_at) VALUES (?, ?, ?) ' + 'ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at').run(user_id, session_id, Date.now());
        probe('state', 'route.bound', {
            user_id,
            session_id
        });
    }
    list_users() {
        const rows = this.db.prepare('SELECT user_id FROM route ORDER BY updated_at DESC').all();
        return rows.map((row)=>row.user_id);
    }
    route_summary() {
        const row = this.db.prepare('SELECT COUNT(*) AS users, COUNT(DISTINCT session_id) AS sessions FROM route').get();
        return {
            users: row?.users ?? 0,
            sessions: row?.sessions ?? 0
        };
    }
    put_delivery_if_absent(record) {
        const existing = this.db.prepare('SELECT delivery_id FROM delivery WHERE delivery_id = ?').get(record.delivery_id);
        if (existing !== undefined) {
            probe('state', 'delivery.duplicate', {
                delivery_id: record.delivery_id,
                user_id: record.user_id
            });
            return false;
        }
        this.db.prepare('INSERT INTO delivery (delivery_id, user_id, status, received_at, attempt, context_token, payload_json) ' + 'VALUES (?, ?, ?, ?, 0, ?, ?)').run(record.delivery_id, record.user_id, 'received', record.received_at, record.context_token ?? null, record.payload_json ?? null);
        probe('state', 'delivery.received', {
            delivery_id: record.delivery_id,
            user_id: record.user_id,
            has_context_token: record.context_token !== undefined
        });
        return true;
    }
    latest_user_id() {
        const row = this.db.prepare('SELECT user_id FROM delivery ORDER BY received_at DESC LIMIT 1').get();
        return row?.user_id;
    }
    delivery_context_token(delivery_id) {
        const row = this.db.prepare('SELECT context_token FROM delivery WHERE delivery_id = ?').get(delivery_id);
        return row?.context_token ?? undefined;
    }
    get_delivery(delivery_id) {
        const row = this.db.prepare('SELECT * FROM delivery WHERE delivery_id = ?').get(delivery_id);
        return row === undefined ? undefined : to_delivery(row);
    }
    update_delivery(delivery_id, status, fields) {
        const current = this.get_delivery(delivery_id);
        if (current === undefined) throw new Error(`delivery 不存在：${delivery_id}`);
        if (fields?.expect !== undefined && current.status !== fields.expect) {
            probe('state', 'delivery.cas_miss', {
                delivery_id,
                expected: fields.expect,
                actual: current.status
            });
            return false;
        }
        const result = this.db.prepare('UPDATE delivery SET status = ?, session_id = COALESCE(?, session_id), injected_at = COALESCE(?, injected_at), ' + 'last_error = ?, attempt = attempt + ? WHERE delivery_id = ? AND status = ?').run(status, fields?.session_id ?? null, fields?.injected_at ?? null, fields?.last_error ?? null, fields?.increment_attempt === true ? 1 : 0, delivery_id, fields?.expect ?? current.status);
        if (result.changes === 0) return false;
        probe('state', 'delivery.status', {
            delivery_id,
            from: current.status,
            to: status,
            attempt: current.attempt + (fields?.increment_attempt === true ? 1 : 0)
        });
        return true;
    }
    list_unfinished_deliveries(limit = 200) {
        const rows = this.db.prepare("SELECT * FROM delivery WHERE status IN ('received','routing','failed_retryable') ORDER BY received_at LIMIT ?").all(limit);
        return rows.map(to_delivery);
    }
    batch_committable(delivery_ids) {
        if (delivery_ids.length === 0) return true;
        const placeholders = delivery_ids.map(()=>'?').join(',');
        const row = this.db.prepare(`SELECT COUNT(*) AS pending FROM delivery WHERE delivery_id IN (${placeholders}) ` + "AND status NOT IN ('injected','control_applied','failed_terminal')").get(...delivery_ids);
        return (row?.pending ?? 0) === 0;
    }
    enqueue_outbox(input) {
        return this.transaction(()=>{
            if (input.client_id !== undefined) {
                const prior = this.db.prepare('SELECT * FROM outbox WHERE client_id=?').get(input.client_id);
                if (prior !== undefined) return to_outbox(prior);
            }
            const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM outbox WHERE session_id = ?').get(input.session_id);
            const sequence = (row?.last ?? 0) + 1;
            const outbound_id = `${input.session_id}:${sequence}`;
            const client_id = input.client_id ?? `dsh-${input.session_id}-${sequence}-${Date.now().toString(36)}`;
            const created_at = Date.now();
            this.db.prepare('INSERT INTO outbox (outbound_id, session_id, user_id, turn, sequence, kind, text, context_token, client_id, ' + 'status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').run(outbound_id, input.session_id, input.user_id, input.turn ?? null, sequence, input.kind, input.text, input.context_token ?? null, client_id, 'pending', created_at);
            probe('state', 'outbox.enqueued', {
                outbound_id,
                session_id: input.session_id,
                kind: input.kind,
                sequence,
                text_len: input.text.length
            });
            return {
                outbound_id,
                session_id: input.session_id,
                user_id: input.user_id,
                ...input.turn === undefined ? {} : {
                    turn: input.turn
                },
                sequence,
                kind: input.kind,
                text: input.text,
                ...input.context_token === undefined ? {} : {
                    context_token: input.context_token
                },
                client_id,
                status: 'pending',
                attempt: 0,
                created_at
            };
        });
    }
    next_outbox(session_id, now = Date.now()) {
        const row = this.db.prepare("SELECT * FROM outbox WHERE session_id = ? AND (status = 'pending' OR (status = 'failed_retryable' AND " + '(next_retry_at IS NULL OR next_retry_at <= ?))) ORDER BY (turn IS NULL), sequence LIMIT 1').get(session_id, now);
        return row === undefined ? undefined : to_outbox(row);
    }
    next_outbox_per_session(now = Date.now()) {
        const rows = this.db.prepare("SELECT * FROM outbox WHERE status = 'pending' OR (status = 'failed_retryable' AND " + '(next_retry_at IS NULL OR next_retry_at <= ?)) ORDER BY session_id, (turn IS NULL), sequence').all(now);
        const seen = new Set();
        const result = [];
        for (const row of rows){
            if (seen.has(row.session_id)) continue;
            seen.add(row.session_id);
            result.push(to_outbox(row));
        }
        return result;
    }
    mark_outbox_sending(outbound_id) {
        this.db.prepare("UPDATE outbox SET status = 'sending', attempt = attempt + 1 WHERE outbound_id = ?").run(outbound_id);
        probe('state', 'outbox.sending', {
            outbound_id
        });
    }
    parked_results(limit = 20) {
        return this.db.prepare("SELECT outbound_id, sequence, text, created_at FROM outbox " + "WHERE turn IS NULL AND status IN ('pending','failed_retryable','failed_terminal') " + 'ORDER BY sequence LIMIT ?').all(limit);
    }
    prune_parked_results(max_age_ms, now = Date.now()) {
        const removed = this.db.prepare("DELETE FROM outbox WHERE turn IS NULL AND status IN ('pending','failed_retryable','failed_terminal') " + 'AND created_at < ?').run(now - max_age_ms).changes;
        if (removed > 0) probe('state', 'parked.pruned', {
            removed,
            max_age_ms
        });
        return Number(removed);
    }
    trim_pending_notices(session_id, keep = 3) {
        const removed = this.db.prepare("DELETE FROM outbox WHERE outbound_id IN (" + "  SELECT outbound_id FROM outbox WHERE session_id = ? AND status = 'pending' AND turn IS NULL " + '  ORDER BY sequence DESC LIMIT -1 OFFSET ?)').run(session_id, keep).changes;
        if (removed > 0) probe('state', 'outbox.notices_trimmed', {
            session_id,
            removed,
            keep
        });
        return Number(removed);
    }
    mark_outbox_part_sent(outbound_id, index) {
        const row = this.db.prepare('SELECT sent_parts_json FROM outbox WHERE outbound_id = ?').get(outbound_id);
        if (row === undefined) return;
        const parts = parse_sent_parts(row.sent_parts_json);
        if (parts.includes(index)) return;
        parts.push(index);
        parts.sort((a, b)=>a - b);
        this.db.prepare('UPDATE outbox SET sent_parts_json = ? WHERE outbound_id = ?').run(JSON.stringify(parts), outbound_id);
        probe('state', 'outbox.part_sent', {
            outbound_id,
            index,
            parts: parts.length
        });
    }
    mark_outbox_sent(outbound_id) {
        this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE outbound_id = ?").run(Date.now(), outbound_id);
        probe('state', 'outbox.sent', {
            outbound_id
        });
    }
    mark_outbox_failed(outbound_id, status, error, next_retry_at) {
        this.db.prepare('UPDATE outbox SET status = ?, last_error = ?, next_retry_at = ? WHERE outbound_id = ?').run(status, error, next_retry_at ?? null, outbound_id);
        probe('state', 'outbox.failed', {
            outbound_id,
            status,
            error
        });
    }
    get_outbox(outbound_id) {
        const row = this.db.prepare('SELECT * FROM outbox WHERE outbound_id = ?').get(outbound_id);
        return row === undefined ? undefined : to_outbox(row);
    }
    list_pending_outbox(limit = 500) {
        const rows = this.db.prepare("SELECT * FROM outbox WHERE status IN ('pending','sending','failed_retryable') ORDER BY session_id, sequence LIMIT ?").all(limit);
        return rows.map(to_outbox);
    }
    bind_turn_context(input) {
        this.db.prepare('INSERT INTO turn_context (session_id, turn, delivery_id, user_id, context_token, created_at) VALUES (?, ?, ?, ?, ?, ?) ' + 'ON CONFLICT(session_id, turn) DO UPDATE SET delivery_id = excluded.delivery_id, ' + 'user_id = excluded.user_id, context_token = excluded.context_token').run(input.session_id, input.turn, input.delivery_id, input.user_id, input.context_token ?? null, Date.now());
        probe('state', 'turn_context.bound', {
            session_id: input.session_id,
            turn: input.turn,
            delivery_id: input.delivery_id,
            has_token: input.context_token !== undefined
        });
    }
    get_turn_context(session_id, turn) {
        const row = this.db.prepare('SELECT * FROM turn_context WHERE session_id = ? AND turn = ?').get(session_id, turn);
        if (row === undefined) return undefined;
        return {
            delivery_id: row.delivery_id,
            user_id: row.user_id,
            ...row.context_token === null ? {} : {
                context_token: row.context_token
            }
        };
    }
    latest_delivery_for_session(session_id) {
        const row = this.db.prepare("SELECT * FROM delivery WHERE session_id = ? AND status IN ('injected','control_applied') ORDER BY received_at DESC LIMIT 1").get(session_id);
        return row === undefined ? undefined : to_delivery(row);
    }
    prune_turn_context(session_id, keep = 20) {
        this.db.prepare('DELETE FROM turn_context WHERE session_id = ? AND turn NOT IN ' + '(SELECT turn FROM turn_context WHERE session_id = ? ORDER BY turn DESC LIMIT ?)').run(session_id, session_id, keep);
    }
    get_lease() {
        const row = this.db.prepare('SELECT owner_id, pid, heartbeat_at, account_id, process_started_at FROM consumer_lease WHERE id = 1').get();
        return row;
    }
    try_acquire_lease(input) {
        const now = Date.now();
        return this.transaction(()=>{
            const existing = this.get_lease();
            if (existing !== undefined) {
                const alive = lease_holder_alive(existing.pid, existing.process_started_at);
                if (alive) {
                    probe('state', 'lease.busy', {
                        held_by: existing.owner_id,
                        pid: existing.pid,
                        age_ms: now - existing.heartbeat_at
                    });
                    return false;
                }
                probe('state', 'lease.takeover', {
                    held_by: existing.owner_id,
                    pid: existing.pid,
                    pid_alive: alive,
                    age_ms: now - existing.heartbeat_at,
                    reason: alive ? 'stale' : 'holder_dead'
                });
            }
            this.db.prepare('INSERT INTO consumer_lease (id, owner_id, pid, process_started_at, account_id, acquired_at, heartbeat_at) ' + 'VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, pid = excluded.pid, ' + 'process_started_at = excluded.process_started_at, account_id = excluded.account_id, ' + 'acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at').run(input.owner_id, input.pid, input.process_started_at, input.account_id, now, now);
            probe('state', 'lease.acquired', {
                owner_id: input.owner_id,
                pid: input.pid,
                account_id: input.account_id
            });
            return true;
        });
    }
    heartbeat_lease(owner_id) {
        const row = this.db.prepare('SELECT owner_id FROM consumer_lease WHERE id = 1').get();
        if (row === undefined || row.owner_id !== owner_id) return false;
        this.db.prepare('UPDATE consumer_lease SET heartbeat_at = ? WHERE id = 1').run(Date.now());
        return true;
    }
    release_lease(owner_id) {
        this.db.prepare('DELETE FROM consumer_lease WHERE id = 1 AND owner_id = ?').run(owner_id);
        probe('state', 'lease.released', {
            owner_id
        });
    }
    snapshot() {
        const count = (sql)=>{
            const row = this.db.prepare(sql).get();
            return row?.n ?? 0;
        };
        return {
            cursor_len: this.get_cursor().length,
            routes: this.route_summary(),
            delivery: {
                received: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'received'"),
                injected: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'injected'"),
                control_applied: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'control_applied'"),
                failed_retryable: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'failed_retryable'"),
                failed_terminal: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'failed_terminal'")
            },
            outbox: {
                pending: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'"),
                sending: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sending'"),
                sent: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'"),
                failed_retryable: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed_retryable'"),
                failed_terminal: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed_terminal'")
            },
            lease: this.get_lease() ?? null
        };
    }
}
function is_pid_alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}
function process_started_at(pid) {
    try {
        if (process.platform === 'win32') {
            const out = execFileSync('powershell.exe', [
                '-NoLogo',
                '-NoProfile',
                '-Command',
                `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` + `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` + `if ($p) { Write-Output ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`
            ], {
                encoding: 'utf8',
                timeout: 5_000,
                windowsHide: true
            });
            const parsed = Number(out.trim());
            return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        }
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const startTicks = Number(fields[19]);
        if (!Number.isFinite(startTicks)) return undefined;
        const bootTime = readFileSync('/proc/stat', 'utf8').split('\n').find((line)=>line.startsWith('btime '))?.split(' ')[1];
        const uptimeSeconds = Number(bootTime);
        if (!Number.isFinite(uptimeSeconds)) return undefined;
        return (uptimeSeconds + startTicks / 100) * 1000;
    } catch  {
        return undefined;
    }
}
export function lease_holder_alive(pid, recorded_started_at) {
    if (!is_pid_alive(pid)) return false;
    const actual = process_started_at(pid);
    if (actual === undefined) return true;
    return Math.abs(actual - recorded_started_at) <= 60_000;
}
function to_delivery(row) {
    return {
        delivery_id: row.delivery_id,
        user_id: row.user_id,
        ...row.session_id === null ? {} : {
            session_id: row.session_id
        },
        status: row.status,
        received_at: row.received_at,
        ...row.injected_at === null ? {} : {
            injected_at: row.injected_at
        },
        ...row.last_error === null ? {} : {
            last_error: row.last_error
        },
        attempt: row.attempt,
        ...row.context_token === null ? {} : {
            context_token: row.context_token
        },
        ...row.payload_json === null ? {} : {
            payload_json: row.payload_json
        }
    };
}
function to_outbox(row) {
    return {
        outbound_id: row.outbound_id,
        session_id: row.session_id,
        user_id: row.user_id,
        ...row.turn === null ? {} : {
            turn: row.turn
        },
        sequence: row.sequence,
        kind: row.kind,
        text: row.text,
        ...row.context_token === null ? {} : {
            context_token: row.context_token
        },
        client_id: row.client_id,
        status: row.status,
        attempt: row.attempt,
        ...row.next_retry_at === null ? {} : {
            next_retry_at: row.next_retry_at
        },
        ...row.last_error === null ? {} : {
            last_error: row.last_error
        },
        created_at: row.created_at,
        ...row.sent_at === null ? {} : {
            sent_at: row.sent_at
        },
        sent_parts: parse_sent_parts(row.sent_parts_json)
    };
}
function parse_sent_parts(raw) {
    if (raw === null || raw === '') return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item)=>typeof item === 'number');
    } catch  {
        return [];
    }
}
