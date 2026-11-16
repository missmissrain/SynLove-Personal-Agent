/**
 * 任务通知送达追踪：将执行结束、通道入队、实际送达和等待凭据分别持久记录。
 * 参数runtime为唯一任务运行器；复用任务SQLite句柄，不创建发送队列，不重放任务。
 */
export class TaskNoticeTracker {
  /** runtime含store、channels及脱敏log_event；初始化兼容旧数据库。 */
  constructor(private runtime: any) {
    runtime.store.db.exec(`CREATE TABLE IF NOT EXISTS taskNoticeDelivery(
      taskId TEXT PRIMARY KEY, receipt TEXT, status TEXT NOT NULL, error TEXT, updated INTEGER NOT NULL)`)
  }
  /** taskId、receipt为宿主任务和原通道回执；这里只标记queued，不能当成用户已收到。 */
  record_queued(taskId: string, receipt: string): void {
    this.runtime.store.db.prepare(`INSERT INTO taskNoticeDelivery VALUES(?,?,'queued',NULL,?)
      ON CONFLICT(taskId) DO UPDATE SET receipt=excluded.receipt,status='queued',error=NULL,updated=excluded.updated`)
      .run(taskId, receipt, Date.now())
  }
  /** taskId为任务ID；返回独立送达状态，供主人格查询，未知不能声称已报备。 */
  get_delivery(taskId: string): any {
    return this.runtime.store.db.prepare('SELECT receipt,status,error,updated FROM taskNoticeDelivery WHERE taskId=?').get(taskId)
      ?? { status: 'not_queued' }
  }
  /** 无参数；轮询原通道回执。旧记录通过稳定幂等键恢复回执，不重复执行或重新润色。 */
  async refresh_delivery(): Promise<void> {
    const rows = this.runtime.store.db.prepare(`SELECT t.*,d.receipt,d.status AS deliveryStatus
      FROM agentTasks t LEFT JOIN taskNoticeDelivery d ON d.taskId=t.id
      WHERE t.queued=1 AND t.notice IS NOT NULL AND
        ((d.taskId IS NULL AND t.updated>?) OR d.status NOT IN ('sent','failed_terminal','missing'))
      ORDER BY t.created LIMIT 128`).all(Date.now() - 86400000)
    for (const row of rows as any[]) {
      if (this.runtime.stopped) break
      const task = { ...row, origin: JSON.parse(row.origin) }
      const handler = this.runtime.channels.get(task.origin.channel)
      if (!handler?.delivery_status) continue
      try {
        this.runtime.assert_owner()
        const receipt = row.receipt ?? await handler.send(task, task.notice)
        const value = await handler.delivery_status(receipt, task)
        const status = value?.status ?? 'missing'
        this.runtime.assert_owner()
        this.runtime.store.db.prepare(`INSERT INTO taskNoticeDelivery VALUES(?,?,?,?,?)
          ON CONFLICT(taskId) DO UPDATE SET receipt=excluded.receipt,status=excluded.status,
          error=excluded.error,updated=excluded.updated`)
          .run(task.id, receipt, status, value?.error ?? null, Date.now())
        if (status !== row.deliveryStatus)
          this.runtime.log_event('notice.delivery', { taskId: task.id, receipt, status })
      } catch (error) {
        this.runtime.log_event('notice.delivery_deferred', { taskId: task.id, error: String(error).slice(0,160) })
      }
    }
  }
}
