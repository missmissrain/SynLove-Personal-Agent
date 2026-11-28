/**
 * 观测 HTTP 真实路由测试：验证查询、评分、跨站拒绝和正文上限。
 * 注册参数 node --test；只使用随机回环端口和临时数据库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObservationStore } from '../ObservationStore.mjs'
import { ObservationRoutes } from '../ObservationRoutes.mjs'

test('真实路由查询与评分成功，非法来源、格式、ID 和超大正文分别拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synloveObservationRoutes-'))
  await mkdir(join(root, 'runtime'))
  await mkdir(join(root, 'config'))
  const traceId = 'a'.repeat(32)
  const spanId = 'b'.repeat(16)
  await writeFile(join(root, 'runtime', 'observations.jsonl'), JSON.stringify({
    traceId, spanId, kind: 'model', phase: 'end', status: 'ok', at: new Date().toISOString(), model: 'fake',
  }) + '\n')
  const store = new ObservationStore({ runtime: join(root, 'runtime'), config: join(root, 'config') })
  const routes = new ObservationRoutes(store, 'http://127.0.0.1:3082')
  const server = createServer((req, res) => {
    if (!routes.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const body = JSON.stringify({ traceId, spanId, score: 4, note: '真实 HTTP 评分' })
  const post = (headers, text = body) => fetch(`${base}/api/observations/score`, { method: 'POST', headers, body: text })
  try {
    assert.equal((await fetch(`${base}/api/observations`)).status, 200)
    assert.equal((await fetch(`${base}/api/observations/trends`)).status, 200)
    assert.equal((await fetch(`${base}/api/observations/detail?traceId=invalid`)).status, 400)
    assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'http://evil.invalid' })).status, 403)
    assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await post({ 'Content-Type': 'application/json' }, '{bad')).status, 400)
    assert.equal((await post({ 'Content-Type': 'application/json' }, 'x'.repeat(9000))).status, 413)
    assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3082' })).status, 200)
    const detail = await (await fetch(`${base}/api/observations/detail?traceId=${traceId}`)).json()
    assert.equal(detail.spans[0].score.score, 4)
    assert.equal((await fetch(`${base}/api/observations/score`)).status, 405)
  } finally {
    await new Promise(resolve => server.close(resolve))
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
