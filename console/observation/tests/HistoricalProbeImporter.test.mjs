/**
 * 历史补录测试：验证用量、错误、关联缺口、重复读取与原生去重。
 * 注册参数 node --test；默认使用临时目录，不调用真实模型和消息接口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoricalProbeImporter } from '../HistoricalProbeImporter.mjs'
import { ObservationStore } from '../ObservationStore.mjs'

/** 参数 rows：模拟探针行；生成完整换行文本供解析。 */
function probe_text(rows) { return rows.map(row => JSON.stringify(row)).join('\n') + '\n' }
const at = new Date().toISOString()
const req = { at, kind: 'request', model: 'fake', provider: 'test' }
const end = { at, kind: 'event', type: 'done', model: 'fake', stopReason: 'stop',
  usage: { input: 5, output: 2, cacheRead: 10, totalTokens: 17 } }

test('补录保留缓存用量，输出稳定且不泄漏正文', () => {
  const importer = new HistoricalProbeImporter()
  const text = probe_text([req, { at, kind: 'event', type: 'text_delta', model: 'fake', delta: 'secret' }, end])
  const result = importer.parse_records(text)
  assert.deepEqual(result, importer.parse_records(text))
  assert.equal(result.records[0].usage.cacheReadTokens, 10)
  assert.equal(result.records[0].durationMs, 0)
  assert.equal(result.records[0].status, 'ok')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(result.records[0].sessionId, undefined)
})

test('重叠请求和孤立终态不伪造耗时；错误和未知结束原因分别记录', () => {
  const { records, report } = new HistoricalProbeImporter().parse_records(probe_text([
    req, req, end, end, { ...end, type: 'error' }, { ...end, stopReason: 'unknown' },
  ]))
  assert.ok(records.every(row => row.durationMs === undefined && row.provider === undefined))
  assert.equal(report.ambiguous, 1)
  assert.equal(records[2].status, 'error')
  assert.equal(records[3].status, 'incomplete')
})

test('坏行、半行和未结束请求明确统计', () => {
  const result = new HistoricalProbeImporter().parse_records('broken\n' + probe_text([req]) + '{"partial"')
  assert.equal(result.report.malformed, 1)
  assert.equal(result.report.unfinished, 1)
  assert.equal(result.records.length, 0)
})

test('实际查询历史列表、趋势且与原生结束事件去重', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synloveHistory-'))
  const row = new HistoricalProbeImporter().parse_records(probe_text([req, end])).records[0]
  const store = new ObservationStore({ runtime: root, config: root })
  try {
    await writeFile(join(root, 'observations.history.jsonl'), probe_text([row]))
    assert.equal((await store.list()).total, 1)
    assert.equal((await store.trends(7)).summary.totalTokens, 17)
    assert.equal((await store.trends(7)).health.historical, 1)
    assert.equal((await store.list()).total, 1)
    await writeFile(join(root, 'observations.jsonl'), probe_text([{ ...row, traceId: 'f'.repeat(32), source: 'native' }]))
    store.cache = undefined
    assert.equal((await store.list()).total, 1)
    assert.equal((await store.trends(7)).health.historical, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
