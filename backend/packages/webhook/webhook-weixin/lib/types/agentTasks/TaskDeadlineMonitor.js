export class TaskDeadlineMonitor {
    runtime;
    bridge;
    retries = new Map();
    constructor(runtime, bridge){
        this.runtime = runtime;
        this.bridge = bridge;
    }
    is_current(task, entry, deadline) {
        return !this.runtime.stopped && !this.bridge.stopped && this.runtime.active.get(task.id) === entry && entry.deadlineAt === deadline && deadline > Date.now() && this.runtime.store.get_task(task.id, task.session).state === 'running';
    }
    async pump_notices() {
        for (const [id, entry] of this.runtime.active){
            if (this.runtime.stopped || this.bridge.stopped) break;
            const task = this.runtime.store.get_task(id, entry.task.session);
            const deadline = entry.deadlineAt;
            const budget = deadline - entry.startedAt;
            const lead = Math.min(this.runtime.config.deadlineLeadMs ?? 300000, budget / 12);
            const key = `${id}:deadline:${deadline}`;
            if (!Number.isFinite(deadline) || !Number.isFinite(lead) || lead <= 0 || deadline - Date.now() > lead || !this.is_current(task, entry, deadline) || (this.retries.get(key) ?? 0) > Date.now()) continue;
            const prior = this.runtime.store.get_deadline_notice(id, deadline);
            if (prior?.queued) continue;
            const handler = this.runtime.channels.get(task.origin.channel);
            if (!handler) continue;
            let agent;
            try {
                agent = await handler.resolve(task.origin);
            } catch  {
                continue;
            }
            if (!agent || agent.status !== 'idle' || this.bridge.busy.has(String(agent.id))) continue;
            const session = String(agent.id);
            this.bridge.busy.add(session);
            try {
                this.runtime.assert_owner();
                if (!this.is_current(task, entry, deadline)) continue;
                let text = prior?.text;
                if (!text) {
                    text = await this.bridge.present_result(agent, {
                        ...task,
                        deadlineNotice: {
                            deadlineAt: deadline,
                            startedAt: entry.startedAt,
                            progress: this.runtime.progress.read(id, 8).map((row)=>({
                                    at: row.at,
                                    text: String(row.text ?? '').slice(0, 1200)
                                }))
                        }
                    });
                    this.runtime.assert_owner();
                    if (!this.is_current(task, entry, deadline)) continue;
                    this.runtime.store.save_deadline_notice(id, deadline, text);
                }
                if (!this.is_current(task, entry, deadline)) continue;
                const receipt = await handler.send({
                    ...task,
                    id: key
                }, text);
                this.runtime.assert_owner();
                this.runtime.store.queue_deadline_notice(id, deadline);
                this.retries.delete(key);
                this.runtime.log_event('deadline.enqueued', {
                    taskId: id,
                    deadlineAt: deadline,
                    receipt
                });
            } catch (error) {
                this.retries.set(key, Date.now() + 30000);
                this.runtime.log_event('deadline.deferred', {
                    taskId: id,
                    error: String(error).slice(0, 200)
                });
            } finally{
                this.bridge.busy.delete(session);
            }
        }
    }
}
