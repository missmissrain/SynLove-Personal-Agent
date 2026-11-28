/**
 * QQ 网关原子互斥：SQLite 事务裁决所有权，PID 文件仅供界面读取。
 * 参数 path 为独立租约库路径；无账号信息。存活且启动时刻一致的持有者不得被抢占。
 */
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** pid 为进程号；仅判断该进程是否存在。 */
function is_pid_alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error: unknown) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

/** pid 为进程号；读取进程启动时刻，权限不足时返回 undefined。 */
function process_started_at(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; `
        + `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
        + `if ($p) { Write-Output ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`,
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
      const value = Number(out.trim())
      return Number.isFinite(value) && value > 0 ? value : undefined
    }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
    const boot = Number(readFileSync('/proc/stat', 'utf8').split('\n')
      .find(line => line.startsWith('btime '))?.split(' ')[1])
    return Number.isFinite(ticks) && Number.isFinite(boot) ? (boot + ticks / 100) * 1000 : undefined
  } catch { return undefined }
}

/** pid 与记录的启动时刻匹配时视为活跃持有者，防止 PID 回收误判。 */
function lease_holder_alive(pid: number, recorded_started_at: number): boolean {
  if (!is_pid_alive(pid)) return false
  const actual = process_started_at(pid)
  return actual === undefined || Math.abs(actual - recorded_started_at) <= 60_000
}

export class QqGatewayLease {
  private readonly db: DatabaseSync
  private readonly owner = randomUUID()
  private closed = false

  /** path 为租约库文件；仅初始化锁表，不创建网关连接。 */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('CREATE TABLE IF NOT EXISTS gateway_lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, pid INTEGER, started_at INTEGER)')
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0)
    if (version === 0) this.db.exec('PRAGMA user_version=1')
    else if (version !== 1) throw new Error(`QQ lease schema 版本不匹配：${version}`)
  }

  /** 无参数；单个事务核对活进程并获取租约，冲突返回 false。 */
  acquire_lease(): boolean {
    if (this.closed) throw new Error('QQ lease 已关闭')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT pid,started_at FROM gateway_lease WHERE id=1').get() as
        { pid: number; started_at: number } | undefined
      if (row && lease_holder_alive(row.pid, row.started_at)) {
        this.db.exec('COMMIT')
        return false
      }
      this.db.prepare('INSERT INTO gateway_lease VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,started_at=excluded.started_at')
        .run(this.owner, process.pid, Date.now() - Math.round(process.uptime() * 1000))
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 无参数；仅释放自己的租约并关闭连接，重复释放无副作用。 */
  release_lease(): void {
    if (this.closed) return
    this.db.prepare('DELETE FROM gateway_lease WHERE owner=?').run(this.owner)
    this.db.close()
    this.closed = true
  }
}
