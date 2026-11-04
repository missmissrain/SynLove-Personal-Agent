/**
 * 执行进度缓存：每个后台任务一份只追加的 JSONL 文件，记录执行内核每一次助手回复。
 * 参数 root 为项目根目录；缓存固定落在 runtime/agentTasks/progress，不接受模型传入的路径。
 * 任务结束时由 TaskRuntime 整份销毁，不留历史。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export class TaskProgressCache {
  /** root 为宿主工作目录；只用来拼固定子目录，不读取其他位置。 */
  constructor(private root: string) {}
  /** 无参数；缓存目录按工程固定放在 runtime/agentTasks/progress。 */
  private dir(): string { return join(this.root, 'runtime', 'agentTasks', 'progress') }
  /** id 为任务ID，只允许安全字符，避免拼出目录外的路径。 */
  private path(id: string): string {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error('任务ID不能用于进度缓存')
    return join(this.dir(), `${id}.jsonl`)
  }
  /** id 为任务ID，text 为本轮助手回复正文，at 为时间戳；追加一行，每一条都保留。 */
  append(id: string, text: string, at: number): void {
    const body = String(text ?? '').trim()
    if (!body) return
    const file = this.path(id)
    mkdirSync(this.dir(), { recursive: true })
    appendFileSync(file, JSON.stringify({ at, text: body.slice(0, 8000) }) + '\n', 'utf8')
  }
  /** id 为任务ID；返回缓存条目数，用于主人格判断有没有新回复。 */
  count(id: string): number {
    const file = this.path(id)
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).length
  }
  /** id 为任务ID，limit 最多返回多少条（默认30，最新的在后）；返回缓存条目，没有缓存时为空数组。 */
  read(id: string, limit = 30): any[] {
    const file = this.path(id)
    if (!existsSync(file)) return []
    const rows: any[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* 半行写入直接跳过，不影响其余条目 */ }
    }
    return rows.slice(-Math.max(1, Math.min(200, limit)))
  }
  /** id 为任务ID；任务结束（成功、失败、取消、超时）后整份删除。 */
  clear(id: string): void {
    try { rmSync(this.path(id), { force: true }) } catch { /* 缓存删不掉不能影响任务收尾 */ }
    try {
      const dir = this.dir()
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch { /* 目录清理失败同样忽略 */ }
  }
}
