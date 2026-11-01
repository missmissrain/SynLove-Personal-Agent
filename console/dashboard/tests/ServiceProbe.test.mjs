/**
 * 服务探活回归：用本机隔离HTTP端口与假响应验证身份、路由与状态分类。
 * 默认不启动任何业务服务，不读取生产数据库，不连接模型或消息平台。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ServiceProbe } from '../ServiceProbe.mjs'

const refused = async () => { throw Object.assign(new Error('offline'), { cause: { code: 'ECONNREFUSED' } }) }
const cfg = { baseURL: 'http://127.0.0.1:1/v1', management: 'managed' }

test('业务服务按API前缀探活，身份正确才亮灯', async t => {
  const paths = []
  const server = createServer((req, res) => {
    paths.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, service: 'state', protocol: 1 }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const probe = new ServiceProbe({ env: {} })
  const config = { ...cfg, baseURL: `http://127.0.0.1:${server.address().port}/v1` }
  assert.equal((await probe.probe_service('state', config)).available, true)
  assert.equal((await probe.probe_service('qqstate', config)).available, false)
  assert.deepEqual(paths, ['/v1/health', '/v1/health'])
})

test('本地存储接口未监听时不冒充故障或可用', async () => {
  const probe = new ServiceProbe({ env: {}, fetcher: refused })
  const result = await probe.probe_service('session', { ...cfg, mode: 'local' })
  assert.equal(result.readiness, 'inactive')
  assert.equal(result.available, false)
  assert.equal((await probe.probe_service('session', { ...cfg, mode: 'remote' })).readiness, 'unavailable')
})

test('工具按需服务未启动时保留灰灯和等待调用说明', async () => {
  const probe = new ServiceProbe({ env: {}, fetcher: refused })
  const result = await probe.probe_service('video', cfg)
  assert.equal(result.readiness, 'pending')
  assert.equal(result.available, false)
})

test('音频待机必须经过现有依赖检查', async () => {
  const probe = new ServiceProbe({ env: {}, fetcher: refused, readiness: { assess: async name => name === 'tts' } })
  assert.equal((await probe.probe_service('tts', cfg)).readiness, 'standby')
  assert.equal((await probe.probe_service('asr', cfg)).available, false)
})

test('禁用服务不发请求；远程失联不判成本机待机', async () => {
  let calls = 0
  const probe = new ServiceProbe({ env: {}, fetcher: async () => { calls++; return refused() } })
  assert.equal((await probe.probe_service('video', { ...cfg, management: 'disabled' })).readiness, 'disabled')
  assert.equal(calls, 0)
  assert.equal((await probe.probe_service('video', { ...cfg, management: 'external' })).readiness, 'unavailable')
})

test('鉴权失败与身份错误不能伪装成正常服务', async () => {
  const probe = new ServiceProbe({ env: {}, fetcher: async () => new Response('{}', { status: 401 }) })
  const result = await probe.probe_service('state', cfg)
  assert.equal(result.available, false)
  assert.match(result.detail, /401/)
})

test('RSSHub和OpenCode使用各自健康接口，不使用通用health', async () => {
  const paths = []
  const probe = new ServiceProbe({ env: {}, fetcher: async url => {
    paths.push(url.pathname)
    return new Response(JSON.stringify({ healthy: true }))
  } })
  assert.equal((await probe.probe_service('opencode', cfg)).available, true)
  assert.equal((await probe.probe_service('rsshub', cfg)).available, true)
  assert.deepEqual(paths, ['/global/health', '/healthz'])
})

test('覆盖远程地址默认退出托管，不能显示本机待机', async () => {
  const probe = new ServiceProbe({ env: { SYNLOVE_VIDEO_BASE_URL: 'http://example.invalid/v1' }, fetcher: refused })
  assert.equal((await probe.probe_service('video', cfg)).readiness, 'unavailable')
})
