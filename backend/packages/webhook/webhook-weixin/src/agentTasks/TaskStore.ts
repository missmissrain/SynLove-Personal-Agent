/**
 * 后台任务唯一状态库：保存入站来源、幂等任务、执行终态、总结与待推送正文。
 * 参数 path 为本机 SQLite 路径；默认由 TaskRuntime 指向 runtime/agentTasks/taskStore.sqlite。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export class TaskStore {
  db: DatabaseSync
  /** path 为固定本机数据库；不接受模型提供的路径。 */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS taskOrigins (id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS taskLease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agentTasks (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, key TEXT UNIQUE NOT NULL, origin TEXT NOT NULL,
        request TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, worker TEXT UNIQUE NOT NULL,
        result TEXT, notice TEXT, queued INTEGER NOT NULL DEFAULT 0, error TEXT,
        created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS taskPending ON agentTasks(state,queued,created);`)
    if (!(this.db.prepare('PRAGMA table_info(taskLease)').all() as any[]).some(row => row.name === 'pid'))
      this.db.exec('ALTER TABLE taskLease ADD COLUMN pid INTEGER NOT NULL DEFAULT 0')
  }
  /** id 为稳定入站 ID，session 为主会话；data 只接受宿主构造的原通道信息。 */
  save_origin(id: string, session: string, data: any): void {
    this.db.prepare('INSERT OR IGNORE INTO taskOrigins VALUES (?,?,?)').run(id, session, JSON.stringify(data))
  }
  /** id 与 session 必须同时匹配，防止串用户。 */
  get_origin(id: string, session: string): any {
    const row = this.db.prepare('SELECT data FROM taskOrigins WHERE id=? AND session=?').get(id, session) as any
    return row ? JSON.parse(row.data) : undefined
  }
  /** session、key 为宿主归属及幂等键；重复请求返回原任务。 */
  create_task(session: string, key: string, origin: any, request: string, kind: string): any {
    const id = randomUUID(), now = Date.now()
    this.db.prepare(`INSERT OR IGNORE INTO agentTasks
      (id,session,key,origin,request,kind,state,worker,created,updated) VALUES (?,?,?,?,?,?,'queued',?,?,?)`)
      .run(id, session, key, JSON.stringify(origin), request, kind, `task-${id}`, now, now)
    return this.decode_row(this.db.prepare('SELECT * FROM agentTasks WHERE key=?').get(key))
  }
  /** id 为任务 ID，session 为当前权限范围，不能跨会话读取。 */
  get_task(id: string, session: string): any {
    const row = this.db.prepare('SELECT * FROM agentTasks WHERE id=? AND session=?').get(id, session)
    if (!row) throw new Error('任务不存在或不属于当前会话')
    return this.decode_row(row)
  }
  /** session 为空时仅供运行器使用，否则仅列当前会话。 */
  list_tasks(session?: string): any[] {
    const rows = session === undefined
      ? this.db.prepare('SELECT * FROM agentTasks ORDER BY created').all()
      : this.db.prepare('SELECT * FROM agentTasks WHERE session=? ORDER BY created DESC LIMIT 20').all(session)
    return rows.map(row => this.decode_row(row))
  }
  /** phase 为执行或通知阶段；只扫描有索引的未处理记录，历史任务不反复加载。 */
  pending_tasks(phase: 'work' | 'notice'): any[] {
    const rows = phase === 'work'
      ? this.db.prepare("SELECT * FROM agentTasks WHERE state='queued' ORDER BY created LIMIT 128").all()
      : this.db.prepare(`SELECT * FROM agentTasks WHERE queued=0
        AND state IN ('succeeded','partial','failed','cancelled','interrupted') ORDER BY created LIMIT 128`).all()
    return rows.map(row => this.decode_row(row))
  }
  /** id 为已验证任务；字段由宿主限定，永不拼接模型列名。 */
  update_task(id: string, patch: any): void {
    const allow = new Set(['state', 'result', 'notice', 'queued', 'error'])
    const fields = Object.keys(patch)
    if (!fields.length || fields.some(key => !allow.has(key))) throw new Error('非法任务状态字段')
    this.db.prepare(`UPDATE agentTasks SET ${fields.map(key => `${key}=?`).join(',')},updated=? WHERE id=?`)
      .run(...fields.map(key => patch[key]), Date.now(), id)
  }
  /** 无参数；运行中的旧进程不可安全重放，改为中断并产生持久通知待办。 */
  recover_tasks(): void {
    this.db.prepare(`UPDATE agentTasks SET state='interrupted',
      result='上次运行被中断，尚未重新执行；已有操作可能已经生效，需要核对后再继续。',
      updated=? WHERE state IN ('running','cancelling')`).run(Date.now())
  }
  /** owner 为本运行器随机身份；只有取得/续约者允许写任务状态。 */
  claim_lease(owner: string): boolean {
    const now = Date.now()
    const prior = this.db.prepare('SELECT * FROM taskLease WHERE id=1').get() as any
    if (prior && prior.owner !== owner && prior.pid > 0) {
      try { process.kill(prior.pid, 0) } catch (error: any) {
        // 只有系统明确报告进程不存在才提前接管；权限错误和 PID 复用均保守等待租约到期。
        if (error.code === 'ESRCH') this.db.prepare('DELETE FROM taskLease WHERE owner=? AND until=? AND pid=?')
          .run(prior.owner, prior.until, prior.pid)
      }
    }
    return this.db.prepare(`INSERT INTO taskLease(id,owner,until,pid) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until=excluded.until,pid=excluded.pid
      WHERE taskLease.owner=excluded.owner OR taskLease.until<?`)
      .run(owner, now + 30000, process.pid, now).changes === 1
  }
  /** owner 为当前身份；过期或被替代时拒绝旧回调提交。 */
  has_lease(owner: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM taskLease WHERE id=1 AND owner=? AND until>?').get(owner, Date.now())
  }
  /** owner 为当前身份；仅释放自己持有的租约。 */
  release_lease(owner: string): void { this.db.prepare('DELETE FROM taskLease WHERE owner=?').run(owner) }
  /** row 为数据库记录；只解析宿主保存的来源对象。 */
  private decode_row(row: any): any { return { ...row, origin: JSON.parse(row.origin) } }
  /** 无参数；关闭当前运行器拥有的句柄。 */
  close_store(): void { this.db.close() }
}
