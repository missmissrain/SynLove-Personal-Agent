/**
 * 后台期限预警：在临近截止时给主人格真实进度，由主人格询问用户续时。
 * 参数 runtime 为唯一运行器、bridge 为串行通知桥；默认提前五分钟，短任务提前其时限的十二分之一。
 * 不自动延长，不改最终结果，提醒以原通道和独立去重身份持久投递。
 */
export class TaskDeadlineMonitor {
  retries = new Map<string, number>()
  /** runtime/bridge 为宿主对象，不接收模型构造的期限或目标。 */
  constructor(private runtime: any, private bridge: any) {}
  /** task、entry、deadline 为运行快照；完成、取消、延期或过期后拒绝旧提醒。 */
  is_current(task: any, entry: any, deadline: number): boolean {
    return !this.runtime.stopped && !this.bridge.stopped
      && this.runtime.active.get(task.id) === entry && entry.deadlineAt === deadline
      && deadline > Date.now()
      && this.runtime.store.get_task(task.id, task.session).state === 'running'
  }
  /** 无参数；由结果桥串行调用，失败仅延迟当前提醒，不阻塞最终结果或其他任务。 */
  async pump_notices(): Promise<void> {
    for (const [id, entry] of this.runtime.active) {
      if (this.runtime.stopped || this.bridge.stopped) break
      const task = this.runtime.store.get_task(id, entry.task.session)
      const deadline = entry.deadlineAt
      const budget = deadline - entry.startedAt
      const lead = Math.min(this.runtime.config.deadlineLeadMs ?? 300000, budget / 12)
      const key = `${id}:deadline:${deadline}`
      if (!Number.isFinite(deadline) || !Number.isFinite(lead) || lead <= 0
        || deadline - Date.now() > lead || !this.is_current(task, entry, deadline)
        || (this.retries.get(key) ?? 0) > Date.now()) continue
      const prior = this.runtime.store.get_deadline_notice(id, deadline)
      if (prior?.queued) continue
      const handler = this.runtime.channels.get(task.origin.channel)
      if (!handler) continue
      let agent: any
      try { agent = await handler.resolve(task.origin) } catch { continue }
      if (!agent || agent.status !== 'idle' || this.bridge.busy.has(String(agent.id))) continue
      const session = String(agent.id)
      this.bridge.busy.add(session)
      try {
        this.runtime.assert_owner()
        if (!this.is_current(task, entry, deadline)) continue
        let text = prior?.text
        if (!text) {
          text = await this.bridge.present_result(agent, { ...task, deadlineNotice: {
            deadlineAt: deadline, startedAt: entry.startedAt,
            progress: this.runtime.progress.read(id, 8).map((row: any) =>
              ({ at: row.at, text: String(row.text ?? '').slice(0, 1200) })),
          } })
          this.runtime.assert_owner()
          if (!this.is_current(task, entry, deadline)) continue
          this.runtime.store.save_deadline_notice(id, deadline, text)
        }
        if (!this.is_current(task, entry, deadline)) continue
        // 通道去重键必须与最终结果不同，否则提前提醒会吞掉最终结果。
        const receipt = await handler.send({ ...task, id: key }, text)
        this.runtime.assert_owner()
        this.runtime.store.queue_deadline_notice(id, deadline)
        this.retries.delete(key)
        this.runtime.log_event('deadline.enqueued', { taskId: id, deadlineAt: deadline, receipt })
      } catch (error) {
        this.retries.set(key, Date.now() + 30000)
        this.runtime.log_event('deadline.deferred', { taskId: id, error: String(error).slice(0, 200) })
      } finally { this.bridge.busy.delete(session) }
    }
  }
}
