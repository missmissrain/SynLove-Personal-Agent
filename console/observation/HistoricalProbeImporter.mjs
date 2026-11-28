/**
 * 历史探针导入器：将旧模型探针转为观测元数据，不保存聊天正文、推理和工具参数。
 * 注册参数：无；parse_records 的 text 为有界日志文本，identity 为来源名称。
 * 默认不补造会话、提示词版本和工具执行；同模型请求重叠时放弃耗时关联。
 */
import { createHash } from 'node:crypto'

export class HistoricalProbeImporter {
  /** 参数 text：日志快照；identity：稳定来源标识；返回可复现事件及缺口统计。 */
  parse_records(text, identity = 'llm-probe.log') {
    const records = []
    const pending = new Map()
    const report = { malformed: 0, requests: 0, completed: 0, errors: 0, unmatched: 0, ambiguous: 0, unfinished: 0 }
    const hash = (value, size) => createHash('sha256').update(value).digest('hex').slice(0, size)
    const lines = text.split('\n')
    // 最后半行可能由正在写入的进程产生，等待下次导入，不计为坏行。
    if (lines.at(-1) !== '') lines.pop()
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { report.malformed++; continue }
      if (!Number.isFinite(Date.parse(row.at)) || typeof row.model !== 'string') continue
      if (row.kind === 'request') {
        report.requests++
        const queue = pending.get(row.model) ?? []
        queue.push({ ...row, index })
        pending.set(row.model, queue)
        continue
      }
      if (row.kind !== 'event' || !['done', 'error'].includes(row.type)) continue
      const queue = pending.get(row.model) ?? []
      const request = queue.length === 1 && !queue[0].ambiguous ? queue[0] : undefined
      if (queue.length > 1) {
        report.ambiguous++
        for (const item of queue) item.ambiguous = true
      }
      // 仅消费数量，不把重叠请求的提供方或耗时强行归给某个结束事件。
      queue.shift()
      if (!request) report.unmatched++
      const id = `${identity}:${index}:${row.at}:${row.model}`
      const record = {
        traceId: hash(id, 32), spanId: hash(`${id}:model`, 16),
        kind: 'model', phase: 'end', at: row.at, model: row.model,
        source: 'historical-probe', name: '历史模型调用（链路信息不完整）',
        status: row.type === 'error' || ['error', 'length', 'max-tokens'].includes(row.stopReason)
          ? 'error' : ['aborted', 'cancelled'].includes(row.stopReason)
            ? 'cancelled' : ['stop', 'toolUse', 'tool_use'].includes(row.stopReason) ? 'ok' : 'incomplete',
      }
      if (request) {
        record.provider = request.provider
        const ms = Date.parse(row.at) - Date.parse(request.at)
        if (ms >= 0) record.durationMs = ms
      }
      if (row.usage && typeof row.usage === 'object') {
        record.usage = {}
        for (const [old, key] of Object.entries({
          input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens',
          cacheWrite: 'cacheWriteTokens', totalTokens: 'totalTokens',
        })) {
          const value = row.usage[old]
          if (Number.isFinite(value) && value >= 0) record.usage[key] = value
        }
      }
      report.completed++
      if (record.status === 'error') report.errors++
      records.push(record)
    }
    report.unfinished = [...pending.values()].reduce((sum, rows) => sum + rows.length, 0)
    return { records, report }
  }
}
