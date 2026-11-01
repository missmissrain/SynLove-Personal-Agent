/**
 * QQ 远程持久发送队列：通过 QqStateRemoteClient 读写独立 qqstate 服务。
 * 参数：send 为实际 QQ 发送函数；report 为脱敏状态回调；服务端保存唯一权威队列。
 */
export class QqRemoteOutbox {
    client;
    send;
    report;
    draining = false;
    stopped = false;
    /** 创建只通过远程状态端口工作的 QQ 队列。 */
    constructor(client, send, report) {
        this.client = client;
        this.send = send;
        this.report = report;
    }
    /** 将回复原子加入远程队列，返回远程记录 ID。 */
    async enqueue_reply(reply) {
        const row = await this.client.enqueue(reply);
        return String(row.id);
    }
    /** 串行发送到期消息；同一目标的失败会阻塞其后续消息。 */
    async drain_queue() {
        if (this.draining || this.stopped)
            return;
        this.draining = true;
        const blocked = new Set();
        try {
            for (const raw of await this.client.list_pending()) {
                if (this.stopped)
                    break;
                const row = raw;
                if (row.status === 'failed_terminal')
                    continue;
                const target = JSON.stringify(row.target);
                if (blocked.has(target) || row.next_at > Date.now()) {
                    blocked.add(target);
                    continue;
                }
                const marks = [];
                const mark = (index) => {
                    if (!row.sent_parts.includes(index))
                        row.sent_parts.push(index);
                    marks.push(this.client.mark_part_sent(row.id, index));
                };
                let result;
                try {
                    result = await this.send(row, mark);
                    await Promise.all(marks);
                }
                catch (error) {
                    result = { ok: false, mode: 'passive', error: String(error).slice(0, 160) };
                }
                if (result.ok) {
                    await this.client.mark_sent(row.id);
                }
                else {
                    const attempt = row.attempt + 1;
                    await this.client.mark_failed(row.id, result.error ?? '发送失败', Date.now() + Math.min(300_000, 5_000 * 2 ** attempt), attempt >= 5);
                    blocked.add(target);
                }
                this.report({
                    outbound_id: row.id,
                    ok: result.ok,
                    status: result.ok ? 'sent' : attempt_status(row, result),
                    attempt: row.attempt + (result.ok ? 0 : 1),
                });
            }
        }
        finally {
            this.draining = false;
        }
    }
    /** 停止接收新发送任务；已在途请求由当前调用自然结束。 */
    stop_queue() { this.stopped = true; }
}
function attempt_status(row, result) {
    return result.ok ? 'sent' : (row.attempt + 1 >= 5 ? 'failed_terminal' : 'pending');
}
//# sourceMappingURL=QqRemoteOutbox.js.map