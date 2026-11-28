/**
 * 任务产物存储：将报告与完整执行总结分别原子落盘，不允许模型指定任意写入路径。
 * 注册参数 root 为生产根目录；默认写入 runtime/agentTasks/reports，单份正文最多二百万字符。
 */
import { mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, realpathSync, lstatSync, readFileSync } from 'node:fs'
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
  /** id 为任务标识；只返回报告是否存在与字符数，不读正文，用于任务结果附带产物信息。 */
  report_info(id: string): any {
    const path = this.get_path(id)
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      return { path, exists: false, characters: 0 }
    const text = readFileSync(path, 'utf8')
    return { path, exists: true, characters: text.length }
  }
  /** id 为任务标识，offset/limit 为字符窗口；只读文本片段，缺失或越界时返回空串。 */
  read_report(id: string, offset = 0, limit = 6000): any {
    const info = this.report_info(id)
    if (!info.exists) return { ...info, offset: 0, nextOffset: null, text: '' }
    if (!Number.isInteger(offset) || offset < 0) throw Error('报告偏移必须为非负整数')
    if (!Number.isInteger(limit) || limit < 1 || limit > 20000) throw Error('报告读取长度必须为1至20000字符')
    const text = readFileSync(info.path, 'utf8')
    const end = Math.min(text.length, offset + limit)
    return { ...info, offset, nextOffset: end < text.length ? end : null, text: text.slice(offset, end) }
  }
}
