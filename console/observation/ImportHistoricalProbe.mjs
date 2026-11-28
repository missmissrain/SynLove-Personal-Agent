/**
 * 历史补录入口：读取本项目旧探针，原子生成独立观测副本和中文统计报告。
 * 注册参数：无命令行参数；默认读取 runtime/llm-probe.log，最多 64MiB。
 * 重跑替换同一份派生副本；不改原探针、不访问模型、不操作消息消费者。
 */
import { readFile, stat, writeFile, rename, readdir, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { HistoricalProbeImporter } from './HistoricalProbeImporter.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const runtime = join(root, 'runtime')
const source = join(runtime, 'llm-probe.log')
if ((await stat(source)).size > 67_108_864) throw new Error('历史探针超过 64MiB，请分批处理')
const { records, report } = new HistoricalProbeImporter().parse_records(await readFile(source, 'utf8'))
const native = new Set()
for (const name of await readdir(runtime)) {
  if (!/^observations\.jsonl(?:\.[1-9][0-9]*)?$/.test(name)) continue
  if ((await stat(join(runtime, name))).size > 67_108_864) throw new Error('原生观测超过去重读取上限')
  for (const line of (await readFile(join(runtime, name), 'utf8')).split('\n')) {
    try {
      const row = JSON.parse(line)
      if (row.kind === 'model' && row.phase === 'end') native.add(`${row.at}:${row.model}`)
    } catch { /* 原生日志半行不参与去重。 */ }
  }
}
const selected = records.filter(row => !native.has(`${row.at}:${row.model}`))
const target = join(runtime, 'observations.history.jsonl')
const temp = `${target}.${process.pid}.tmp`
await writeFile(temp, selected.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')
await rename(temp, target)
const totals = selected.reduce((sum, row) => {
  for (const [key, value] of Object.entries(row.usage ?? {})) sum[key] = (sum[key] ?? 0) + value
  return sum
}, {})
const result = { ...report, imported: selected.length, nativeDuplicates: records.length - selected.length,
  firstAt: selected[0]?.at, lastAt: selected.at(-1)?.at, measuredDurations: selected.filter(row => row.durationMs !== undefined).length, totals }
const reportPath = join(root, '..', '审计产物', '控制台样板改版', '历史调用补录报告.md')
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `# 历史调用补录报告\n\n生成时间：${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\n来源为 runtime/llm-probe.log；保留原始时间。每条为历史模型调用，不能还原跨服务完整调用链。缺失会话、工具执行结果及提示词版本，不推测补齐。仅单个待完成请求可计算耗时；重叠请求放弃关联。工具调用生成事件不等于工具执行，不统计为工具执行成功。成本按现有价格表估算，无法确定提供方时标为未估价；不代表历史真实账单。原探针未修改。重复运行替换同一派生副本，并排除同时间同模型的原生结束事件。\n`, 'utf8')
console.log(JSON.stringify(result, null, 2))
