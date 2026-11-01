/**
 * QQ 远程网关租约：租约裁决完全由 qqstate 服务完成。
 * 参数：client 为远程状态客户端，account_id 为 QQ 机器人账号命名空间，stale_ms 为失效窗口。
 */
import { randomUUID } from 'node:crypto';
export class QqRemoteLease {
    client;
    account_id;
    stale_ms;
    owner_id = randomUUID();
    started_at = Date.now() - Math.round(process.uptime() * 1000);
    held = false;
    timer;
    /** 创建远程租约实例。 */
    constructor(client, account_id, stale_ms = 30_000) {
        this.client = client;
        this.account_id = account_id;
        this.stale_ms = stale_ms;
    }
    /** 向服务端原子申请唯一 QQ 消费者租约。 */
    async acquire_lease() {
        this.held = await this.client.acquire_lease({
            ownerId: this.owner_id,
            pid: process.pid,
            startedAt: this.started_at,
            staleMs: this.stale_ms,
            accountId: this.account_id,
        });
        if (this.held && this.timer === undefined) {
            this.timer = setInterval(() => {
                void this.client.heartbeat_lease(this.owner_id).then(ok => {
                    if (!ok)
                        this.held = false;
                }).catch(() => { this.held = false; });
            }, Math.max(1_000, Math.floor(this.stale_ms / 3)));
            this.timer.unref?.();
        }
        return this.held;
    }
    /** 释放当前持有者租约。 */
    async release_lease() {
        if (!this.held)
            return;
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.client.release_lease(this.owner_id);
        this.held = false;
    }
}
//# sourceMappingURL=QqRemoteLease.js.map