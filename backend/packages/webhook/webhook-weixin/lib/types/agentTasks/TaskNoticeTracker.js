export class TaskNoticeTracker {
    runtime;
    constructor(runtime){
        this.runtime = runtime;
        runtime.store.db.exec(`CREATE TABLE IF NOT EXISTS taskNoticeDelivery(
      taskId TEXT PRIMARY KEY, receipt TEXT, status TEXT NOT NULL, error TEXT, updated INTEGER NOT NULL)`);
    }
    record_queued(taskId, receipt) {
        this.runtime.store.db.prepare(`INSERT INTO taskNoticeDelivery VALUES(?,?,'queued',NULL,?)
      ON CONFLICT(taskId) DO UPDATE SET receipt=excluded.receipt,status='queued',error=NULL,updated=excluded.updated`).run(taskId, receipt, Date.now());
    }
    get_delivery(taskId) {
        return this.runtime.store.db.prepare('SELECT receipt,status,error,updated FROM taskNoticeDelivery WHERE taskId=?').get(taskId) ?? {
            status: 'not_queued'
        };
    }
    async refresh_delivery() {
        const rows = this.runtime.store.db.prepare(`SELECT t.*,d.receipt,d.status AS deliveryStatus
      FROM agentTasks t LEFT JOIN taskNoticeDelivery d ON d.taskId=t.id
      WHERE t.queued=1 AND t.notice IS NOT NULL AND
        ((d.taskId IS NULL AND t.updated>?) OR d.status NOT IN ('sent','failed_terminal','missing'))
      ORDER BY t.created LIMIT 128`).all(Date.now() - 86400000);
        for (const row of rows){
            if (this.runtime.stopped) break;
            const task = {
                ...row,
                origin: JSON.parse(row.origin)
            };
            const handler = this.runtime.channels.get(task.origin.channel);
            if (!handler?.delivery_status) continue;
            try {
                this.runtime.assert_owner();
                const receipt = row.receipt ?? await handler.send(task, task.notice);
                const value = await handler.delivery_status(receipt, task);
                const status = value?.status ?? 'missing';
                this.runtime.assert_owner();
                this.runtime.store.db.prepare(`INSERT INTO taskNoticeDelivery VALUES(?,?,?,?,?)
          ON CONFLICT(taskId) DO UPDATE SET receipt=excluded.receipt,status=excluded.status,
          error=excluded.error,updated=excluded.updated`).run(task.id, receipt, status, value?.error ?? null, Date.now());
                if (status !== row.deliveryStatus) this.runtime.log_event('notice.delivery', {
                    taskId: task.id,
                    receipt,
                    status
                });
            } catch (error) {
                this.runtime.log_event('notice.delivery_deferred', {
                    taskId: task.id,
                    error: String(error).slice(0, 160)
                });
            }
        }
    }
}
