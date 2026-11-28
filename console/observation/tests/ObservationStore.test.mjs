/**
 * 观测模块无模型测试：验证并发隔离、异常透传、轮转、评分一致性与查询上限。
 * 注册参数：node --test；临时目录独立于真实运行日志，不调用任何模型或微信接口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { ObservationStore } from '../ObservationStore.mjs'
import { ObservationRecorder } from '../../../backend/packages/llm/llm/lib/index.js'

/** 参数 t/cfg：测试上下文与配置；创建独立运行目录，结束时只清理该临时目录。 */
async function fixture(t, cfg = {}) {
  const root = await mkdtemp(join(tmpdir(), 'synloveObservation-'))
  const runtime = join(root, 'runtime')
  const config = join(root, 'config')
  await mkdir(runtime)
  await mkdir(config)
  await writeFile(join(config, 'observationConfig.json'), JSON.stringify(cfg))
  const store = new ObservationStore({ runtime, config, secret: () => 'test-only-token' })
  t.after(async () => {
    store.close()
    await ObservationRecorder.flush()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'))
    await rm(root, { recursive: true, force: true })
  })
  return { root, runtime, config, store, log: join(runtime, 'observations.jsonl') }
}

/** 参数 log/fn：临时日志路径及异步操作；结束后恢复原有环境变量。 */
async function use_log(log, fn) {
  const original = process.env.DSH_OBSERVATION_LOG
  process.env.DSH_OBSERVATION_LOG = log
  try { await fn(); await ObservationRecorder.flush() } finally {
    await ObservationRecorder.flush()
    if (original === undefined) delete process.env.DSH_OBSERVATION_LOG
    else process.env.DSH_OBSERVATION_LOG = original
  }
}

/** 参数 extra：覆盖模型入参；不包含真实凭据或正文。 */
function options(extra = {}) {
  return { provider: 'fake', model: 'fake-model', messages: [{ role: 'system', content: '测试系统提示词' }, { role: 'user', content: '测试' }], ...extra }
}

/** 参数 source：异步流；收集结果以确保生命周期完整执行。 */
async function collect(source) {
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

/** 参数 fields：事件覆盖；生成固定格式测试数据。 */
function row(fields = {}) {
  return {
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), kind: 'model', phase: 'end',
    status: 'ok', model: 'fake-model', provider: 'fake', sessionId: 'session-test',
    promptVersion: 'c'.repeat(64), toolsVersion: 'd'.repeat(64), durationMs: 100,
    usage: { totalTokens: 20 }, at: new Date().toISOString(), ...fields,
  }
}

test('并发 256 次请求保持 ID、用量和终态独立；不记录正文', async t => {
  const f = await fixture(t)
  await use_log(f.log, async () => {
    const ids = new Set()
    await Promise.all(Array.from({ length: 256 }, (_, i) => collect(ObservationRecorder.model_stream(options({ sessionId: `s-${i}` }), async function* (obs) {
      ids.add(obs.spanId)
      await Promise.resolve()
      yield { type: 'text-delta', index: 0, text: '绝不能进入观测日志的正文' }
      yield { type: 'usage', usage: { inputTokens: i, outputTokens: 1, totalTokens: i + 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))))
    assert.equal(ids.size, 256)
  })
  const text = await readFile(f.log, 'utf8')
  assert.equal(text.includes('绝不能进入观测日志'), false)
  assert.equal(text.includes('测试系统提示词'), false)
  const records = text.trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 512)
  const end = records.filter(item => item.phase === 'end')
  assert.equal(end.length, 256)
  for (const item of end) {
    assert.equal(item.usage.totalTokens, Number(item.sessionId.slice(2)) + 1)
    assert.equal(item.status, 'ok')
    assert.ok(records.some(start => start.phase === 'start' && start.spanId === item.spanId && start.traceId === item.traceId))
  }
})

test('会话轮次与工具结果关联；取消及 token 耗尽不算成功', async t => {
  const f = await fixture(t)
  await use_log(f.log, async () => {
    ObservationRecorder.observe_event('s1', { type: 'turn/start', data: { turn: 8 } })
    const trace = ObservationRecorder.current('s1')
    await collect(ObservationRecorder.model_stream(options({ sessionId: 's1' }), async function* (obs) {
      assert.equal(obs.traceId, trace.traceId)
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    }))
    ObservationRecorder.observe_event('s1', { type: 'tool/call', data: { callId: 'call1', name: 'read_file', arguments: '不保存这个参数' } })
    ObservationRecorder.observe_event('s1', { type: 'tool/result', data: { message: { callId: 'call1', isError: true } } })
    ObservationRecorder.observe_event('s1', { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    assert.equal(ObservationRecorder.current('s1'), undefined)
    assert.equal(ObservationRecorder.turn_context('s1', 8).traceId, trace.traceId)
  })
  const records = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(records.find(item => item.kind === 'turn' && item.phase === 'end').status, 'cancelled')
  assert.equal(records.find(item => item.kind === 'model' && item.phase === 'end').status, 'incomplete')
  const tools = records.filter(item => item.kind === 'tool')
  assert.equal(tools[0].spanId, tools[1].spanId)
  assert.equal(tools[1].status, 'error')
  assert.equal(JSON.stringify(records).includes('不保存这个参数'), false)
})

test('失败、消费者提前关闭及写入失败不改变原流结果', async t => {
  const f = await fixture(t)
  await use_log(f.log, async () => {
    await assert.rejects(collect(ObservationRecorder.model_stream(options(), async function* () { throw new Error('original failure') })), /original failure/)
    const stream = ObservationRecorder.model_stream(options(), async function* () { yield { type: 'text-delta', text: 'first', index: 0 }; throw new Error('should not execute') })
    await stream.next()
    await stream.return()
  })
  const records = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.filter(item => item.phase === 'end').map(item => item.status), ['error', 'incomplete'])
  // 将目录当作日志文件模拟 EISDIR，业务仍获得完整终态。
  await use_log(f.runtime, async () => {
    const chunks = await collect(ObservationRecorder.model_stream(options(), async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  })
})

test('日志轮转严格保留两份，队列溢出可见且不会无限增长', async t => {
  const f = await fixture(t, { maxFileBytes: 4096, retainedFiles: 2, maxQueuedEvents: 16 })
  await use_log(f.log, async () => {
    for (let i = 0; i < 500; i++) ObservationRecorder.emit(row({ name: `test-${i}` }))
    await ObservationRecorder.flush()
    for (let i = 0; i < 30; i++) { ObservationRecorder.emit(row()); await ObservationRecorder.flush() }
  })
  const logs = (await readdir(f.runtime)).filter(name => name.startsWith('observations.jsonl'))
  assert.equal(logs.length, 2)
  const snapshot = await f.store.snapshot()
  assert.ok(snapshot.health.droppedEvents > 0)
  assert.equal(snapshot.health.malformed, 0)
})

test('实际系统提示词与工具定义的指纹分别变化，用户文本不改变系统指纹', async t => {
  const f = await fixture(t, { maxQueuedEvents: 2048 })
  const ids = []
  await use_log(f.log, async () => {
    for (const opts of [
      options(), options({ messages: [{ role: 'system', content: '测试系统提示词' }, { role: 'user', content: '另一个问题' }] }),
      options({ system: '新系统版本' }), options({ tools: [{ name: 'a', description: 'test', parameters: {} }] }),
    ]) await collect(ObservationRecorder.model_stream(opts, async function* (obs) { ids.push(obs); yield { type: 'finish', reason: { kind: 'stop' } } }))
  })
  assert.equal(ids[0].promptVersion, ids[1].promptVersion)
  assert.notEqual(ids[0].promptVersion, ids[2].promptVersion)
  assert.equal(ids[0].promptVersion, ids[3].promptVersion)
  assert.notEqual(ids[0].toolsVersion, ids[3].toolsVersion)
})

test('调用树合并、孤立终态、坏行、未完成写入和筛选分页', async t => {
  const f = await fixture(t)
  await writeFile(f.log, [row({ phase: 'start', name: '<script>unsafe</script>' }), row(), '{bad', JSON.stringify(row()).slice(0, 30)].map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n'))
  const detail = await f.store.detail('a'.repeat(32))
  assert.equal(detail.spans.length, 1)
  assert.equal(detail.spans[0].partial, false)
  assert.equal(detail.spans[0].status, 'ok')
  assert.equal(detail.health.malformed, 1)
  const result = await f.store.list({ q: 'fake-model', status: 'ok' })
  assert.equal(result.total, 1)
  assert.equal((await f.store.list({ q: 'nonexistent' })).total, 0)
  await assert.rejects(f.store.detail('../invalid'), /格式/)
})

test('评分幂等更新、参数校验、跨会话聚合与版本隔离', async t => {
  const f = await fixture(t, { minimumSamples: 2, minimumScores: 1 })
  const other = row({ traceId: 'e'.repeat(32), spanId: 'f'.repeat(16), promptVersion: '0'.repeat(64), status: 'error', durationMs: 1000 })
  await writeFile(f.log, [row(), other, row({ kind: 'tool', spanId: '1'.repeat(16), status: 'error' })].map(JSON.stringify).join('\n') + '\n')
  await f.store.set_score({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), score: 5, note: '初始' })
  await f.store.set_score({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), score: 2, note: '重新评估' })
  const result = await f.store.trends()
  assert.equal(result.summary.calls, 2)
  assert.equal(result.summary.errorRate, 0.5)
  assert.equal(result.summary.rated, 1)
  assert.equal(result.summary.averageScore, 2)
  assert.equal(result.versions.length, 2)
  assert.ok(result.warnings.some(text => text.includes('平均分')))
  await assert.rejects(f.store.set_score({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), score: 6, note: '' }))
  await assert.rejects(f.store.set_score({ traceId: 'a'.repeat(32), spanId: '9'.repeat(16), score: 4, note: '' }))
})

test('20,000 条元数据查询、并发读取合并与读取上限', async t => {
  const f = await fixture(t, { maxRecords: 20_000 })
  const rows = Array.from({ length: 20_000 }, (_, i) => JSON.stringify(row({
    traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0'),
    model: `fake-${i % 3}`, promptVersion: (i % 2).toString().repeat(64),
  }))).join('\n') + '\n'
  await writeFile(f.log, rows)
  const started = performance.now()
  const [a, b] = await Promise.all([f.store.snapshot(), f.store.snapshot()])
  assert.equal(a, b)
  assert.equal(a.records.length, 20_000)
  assert.equal((await f.store.list()).items.length, 50)
  assert.equal((await f.store.trends()).summary.calls, 20_000)
  console.log(`20,000 条观测首次读取与聚合：${Math.round(performance.now() - started)} ms`)
})

test('远端导入鉴权、去重与缓存缺口显式呈现', async t => {
  const f = await fixture(t)
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only-token')
    assert.ok(req.url.startsWith('/v1/observations?after='))
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ cursor: 'boot:1', gap: true, events: [row({ kind: 'relay', eventId: 'boot:1' })] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  await writeFile(join(f.config, 'observationConfig.json'), JSON.stringify({ relay: { enabled: true, baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'TEST' } }))
  await f.store.sync_remote()
  f.store.lastSync = 0
  await f.store.sync_remote()
  assert.equal((await f.store.snapshot()).records.length, 1)
  assert.equal(f.store.remote.gap, true)
  assert.equal(f.store.remote.state, 'ok')
})

test('轮次编号重复不复用 trace，旧 outbox 仍绑定旧 trace；未知恢复记录不猜测', async t => {
  const f = await fixture(t)
  await use_log(f.log, async () => {
    ObservationRecorder.observe_event('restart-like', { type: 'turn/start', data: { turn: 1 } })
    const first = ObservationRecorder.current('restart-like')
    ObservationRecorder.bind_outbound('outbox-old', 'restart-like', 1)
    ObservationRecorder.observe_event('restart-like', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    ObservationRecorder.observe_event('restart-like', { type: 'turn/start', data: { turn: 1 } })
    assert.notEqual(ObservationRecorder.current('restart-like').traceId, first.traceId)
    assert.equal(ObservationRecorder.outbound_context('outbox-old').traceId, first.traceId)
    assert.equal(ObservationRecorder.outbound_context('unknown-after-restart'), undefined)
    ObservationRecorder.forget_session('restart-like')
    assert.equal(ObservationRecorder.outbound_context('outbox-old'), undefined)
  })
})

test('缓存计入价格档位，币种分开估价，前后窗口退化有样本门槛', async t => {
  const f = await fixture(t, { minimumSamples: 2, minimumScores: 1 })
  await writeFile(join(f.config, 'modelConfig.json'), JSON.stringify({
    providers: { fake: { models: [{ id: 'fake-model', pricing: { currency: 'CNY', unit: 'per_million_tokens', tiers: [
      { maxInputTokens: 100, input: 1, output: 2, cacheRead: 0.1 },
      { maxInputTokens: 1000, input: 3, output: 4, cacheRead: 0.3 },
    ] } }] } },
  }))
  const previous = new Date(Date.now() - 8 * 86_400_000).toISOString()
  await writeFile(f.log, [
    row({ spanId: '1'.repeat(16), status: 'error', usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 5 }, durationMs: 1000 }),
    row({ spanId: '2'.repeat(16), status: 'error', usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 5 }, durationMs: 1000 }),
    row({ spanId: '3'.repeat(16), at: previous }),
    row({ spanId: '4'.repeat(16), at: previous }),
  ].map(JSON.stringify).join('\n') + '\n')
  const data = await f.store.trends(7)
  assert.equal(data.summary.costs.CNY, 0.00016)
  assert.equal(data.baseline.calls, 2)
  assert.ok(data.warnings.some(text => text.includes('错误率较前')))
  assert.ok(data.warnings.some(text => text.includes('P95 耗时较前')))
  // 损坏的配置不能让观测查询崩溃。
  await writeFile(join(f.config, 'observationConfig.json'), 'null')
  assert.equal(f.store.settings().maxRecords, 50_000)
})

test('人格原文只在实际进入请求时标记生效，动态系统章节不打散人格归组', async t => {
  const f = await fixture(t)
  const path = join(f.config, 'persona.md')
  await writeFile(path, '我是测试人格')
  const old = process.env.DSH_PERSONA_FILE
  process.env.DSH_PERSONA_FILE = path
  try {
    await use_log(f.log, async () => {
      for (const system of ['我是测试人格\n今天是第一天', '我是测试人格\n今天是第二天', '旧人格仍在运行']) {
        await collect(ObservationRecorder.model_stream(options({ system }), async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }))
      }
      ObservationRecorder.emit({ ...row(), apiKey: '不能写进日志的密钥' })
    })
    const text = await readFile(f.log, 'utf8')
    assert.equal(text.includes('不能写进日志'), false)
    const records = text.trim().split('\n').map(JSON.parse).filter(item => item.kind === 'model' && item.phase === 'start')
    assert.equal(records[0].personaVersion, records[1].personaVersion)
    assert.notEqual(records[0].promptVersion, records[1].promptVersion)
    assert.equal(records[2].personaVersion, undefined)
    const trend = await f.store.trends()
    assert.ok(trend.versions.some(item => item.personaVersion === records[0].personaVersion && item.calls === 2 && item.systemVariants === 2))
  } finally {
    if (old === undefined) delete process.env.DSH_PERSONA_FILE
    else process.env.DSH_PERSONA_FILE = old
  }
})

test('模型步骤结束不等于整轮结束，远端时钟差异不污染轮次耗时', async t => {
  const f = await fixture(t)
  const now = Date.now() - 1000
  const start = row({ kind: 'turn', phase: 'start', spanId: '1'.repeat(16), at: new Date(now).toISOString() })
  await writeFile(f.log, [start, row()].map(JSON.stringify).join('\n') + '\n')
  assert.equal((await f.store.list()).items[0].status, 'incomplete')
  await writeFile(f.log, [
    start, row(),
    row({ kind: 'turn', spanId: '1'.repeat(16), at: new Date(now + 500).toISOString() }),
    row({ kind: 'node', spanId: '2'.repeat(16), at: new Date(now + 600_000).toISOString() }),
  ].map(JSON.stringify).join('\n') + '\n')
  f.store.cache = undefined
  assert.equal((await f.store.list()).items[0].durationMs, 500)
})
