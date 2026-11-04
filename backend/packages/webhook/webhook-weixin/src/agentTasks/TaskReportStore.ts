/**
 * 任务产物存储：将报告与完整执行总结分别原子落盘，不允许模型指定任意写入路径。
 * 注册参数 root 为生产根目录；默认写入 runtime/agentTasks/reports，单份正文最多二百万字符。
 */
import { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, realpathSync, lstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export class TaskReportStore {
  /** root 为宿主固定目录，不采用任务正文中可能过时的目录。 */
  constructor(private root: string) {}
  /** id 为任务标识、kind 为产物类型；校验路径固定在本实例目录内。 */
  get_path(id: string, kind: 'report' | 'summary' = 'report'): string {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error('非法任务产物标识')
    const dir = join(resolve(this.root), 'runtime', 'agentTasks', 'reports')
    mkdirSync(dir, { recursive: true })
    if (!realpathSync(dir).startsWith(realpathSync(this.root) + sep)) throw Error('任务产物目录越界')
    return join(dir, `${kind === 'report' ? '任务报告' : '执行总结'}-${id}.md`)
  }
  /** id 为任务标识，text 为完整正文，kind 默认为报告；原子写入，返回真实文件路径。 */
  save_report(id: string, text: string, kind: 'report' | 'summary' = 'report'): any {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000000) throw Error('报告正文必须为1至二百万字符')
    const file = this.get_path(id, kind), temp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
      renameSync(temp, file)
    } finally { if (existsSync(temp)) unlinkSync(temp) }
    return { path: file, characters: text.length }
  }
  /** task 为宿主保存的任务；完整总结独立归档，不覆盖执行者已保存的长报告。 */
  persist_result(task: any): any {
    const summary = this.save_report(task.id, task.result || '没有取得执行总结。', 'summary')
    const report = this.get_path(task.id)
    const has = existsSync(report) && lstatSync(report).isFile() && !lstatSync(report).isSymbolicLink()
    return { reportPath: has ? report : summary.path, summaryPath: summary.path, reportSaved: has }
  }
}
