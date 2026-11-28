/**
 * 任务证据归档：从正式工具事件提取调用状态及写入文件元信息，不采集推理或完整命令输出。
 * 注册参数root为生产根目录；默认仅核验本工作区内文件，最多保留100个文件和20条失败工具。
 */
import { existsSync, lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

export class TaskEvidence {
  /** root为本任务固定工作区，不能由执行者临时改写。 */
  constructor(private root: string) {}
  /** agent为执行会话，id为宿主任务ID；保存有界证据并返回结构，不读取文件正文。 */
  collect_evidence(agent: any, id: string): any {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) throw Error('非法任务ID')
    const events = agent.session.snapshotEvents(), calls = new Map<string, any>()
    const failures: any[] = [], paths = new Set<string>()
    let returned = 0, errors = 0
    for (const event of events) {
      const data = event.data
      if (event.type === 'tool/call') {
        calls.set(data.callId, data)
        if (['write', 'save_report'].includes(data.name)) {
          try {
            const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
            const path = args?.file_path ?? args?.filePath ?? args?.path
            if (typeof path === 'string') paths.add(path)
          } catch {}
        }
      }
      if (event.type !== 'tool/result') continue
      returned++
      const call = calls.get(data?.message?.source?.callId)
      const blocks = data?.message?.content ?? []
      if (blocks.some((block: any) => block.type === 'tool-result' && block.isError)) {
        errors++
        if (failures.length < 20) failures.push({ tool: call?.name ?? 'unknown', failed: true })
      }
      if (call?.name === 'save_report') {
        for (const block of blocks) {
          for (const part of block.content ?? []) {
            try { const value = JSON.parse(part.text); if (typeof value.path === 'string') paths.add(value.path) } catch {}
          }
        }
      }
    }
    const root = realpathSync(this.root)
    const files = [...paths].slice(0, 100).map(path => {
      const file = resolve(this.root, path)
      if (!file.startsWith(resolve(this.root) + sep)) return { path, checked: false, reason: 'outside-workspace' }
      try {
        const info = lstatSync(file)
        if (info.isSymbolicLink() || !realpathSync(file).startsWith(root + sep))
          return { path, checked: false, reason: 'link-outside-workspace' }
        return { path: file, exists: true, regularFile: info.isFile(), bytes: info.size, contentVerified: false }
      } catch { return { path: file, exists: false, checked: true } }
    })
    const evidence = { toolCalls: calls.size, toolReturns: returned, explicitToolErrors: errors,
      failures, files, note: '文件存在不代表内容正确或已送达；工具返回不代表目标全部完成。' }
    const dir = join(this.root, 'runtime', 'agentTasks', 'evidence')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.json`), temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify(evidence, null, 2), 'utf8'); renameSync(temp, file)
    return { ...evidence, evidencePath: file }
  }
}
