import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export class QqOutbox {
    path;
    send;
    report;
    rows = [];
    draining = false;
    stopped = false;
    receipts = {};
    constructor(path, send, report){
        this.path = path;
        this.send = send;
        this.report = report;
        if (!existsSync(path)) return;
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.some((row)=>typeof row.id !== 'string' || typeof row.text !== 'string' || !Array.isArray(row.sent_parts) || typeof row.attempt !== 'number' || typeof row.next_at !== 'number' || !row.target || ![
                'pending',
                'failed_terminal'
            ].includes(row.status))) {
            throw new Error('QQ outbox 文件格式无效，原文件已保留');
        }
        this.rows = data.rows;
        this.receipts = data.receipts ?? {};
    }
    save_rows() {
        mkdirSync(dirname(this.path), {
            recursive: true
        });
        const temp = `${this.path}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({
            version: 1,
            rows: this.rows,
            receipts: this.receipts
        }), {
            mode: 0o600,
            flush: true
        });
        renameSync(temp, this.path);
    }
    enqueue_reply(reply) {
        if (reply.dedupeKey) {
            const prior = this.receipts[reply.dedupeKey] ?? this.rows.find((row)=>row.dedupeKey === reply.dedupeKey)?.id;
            if (prior) return prior;
        }
        if (reply.msgId !== undefined) {
            const duplicate = this.rows.find((row)=>row.msgId === reply.msgId && JSON.stringify(row.target) === JSON.stringify(reply.target) && row.text === reply.text && row.status !== 'failed_terminal');
            if (duplicate !== undefined) return duplicate.id;
        }
        if (this.rows.length >= 1024) throw new Error('QQ outbox 已满，待发消息未删除');
        const row = {
            ...reply,
            id: randomUUID(),
            attempt: 0,
            next_at: 0,
            status: 'pending',
            sent_parts: []
        };
        this.rows.push(row);
        try {
            this.save_rows();
        } catch (error) {
            this.rows.pop();
            throw error;
        }
        return row.id;
    }
    async drain_queue() {
        if (this.draining || this.stopped) return;
        this.draining = true;
        const blocked = new Set();
        try {
            for (const row of [
                ...this.rows
            ]){
                if (this.stopped) break;
                if (row.status === 'failed_terminal') continue;
                const target = JSON.stringify(row.target);
                if (blocked.has(target)) continue;
                if (row.next_at > Date.now()) {
                    blocked.add(target);
                    continue;
                }
                let result;
                try {
                    result = await this.send(row, (index)=>{
                        if (!row.sent_parts.includes(index)) row.sent_parts.push(index);
                        this.save_rows();
                    });
                } catch (error) {
                    result = {
                        ok: false,
                        mode: 'passive',
                        error: String(error).slice(0, 160)
                    };
                }
                if (result.ok) {
                    if (row.dedupeKey) this.receipts[row.dedupeKey] = row.id;
                    this.rows.splice(this.rows.indexOf(row), 1);
                } else {
                    row.attempt++;
                    row.error = result.error ?? '发送失败';
                    row.next_at = Date.now() + Math.min(300_000, 5_000 * 2 ** row.attempt);
                    if (row.attempt >= 5) row.status = 'failed_terminal';
                    blocked.add(target);
                }
                this.save_rows();
                this.report({
                    outbound_id: row.id,
                    ok: result.ok,
                    status: result.ok ? 'sent' : row.status,
                    attempt: row.attempt
                });
            }
        } finally{
            this.draining = false;
        }
    }
    stop_queue() {
        this.stopped = true;
    }
}
