/**
 * 远程配置集成测试：临时根目录、假凭据和假探测器，真实本机 HTTP 验证路由。
 * 注册参数无；不访问生产配置、VPS 或用户电脑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { RemoteConnectionStore } from '../RemoteConnectionStore.mjs'
import { RemoteConnectionRoutes } from '../RemoteConnectionRoutes.mjs'
import { ServiceProbe } from '../../dashboard/ServiceProbe.mjs'
import { DashboardStore } from '../../dashboard/DashboardStore.mjs'

/** 参数 t 为测试上下文；创建隔离配置目录并在结束时回收。 */
function make_store(t, runner = async () => ({ ok: true, available: true })) {
  const root = mkdtempSync(join(tmpdir(), 'synloveRemoteUi-'))
  mkdirSync(join(root, 'config'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new RemoteConnectionStore({ project: root, python: 'not-used', runner })
}

/** 无参数；返回仅含文档专用域名与假密码的输入，不连接网络。 */
function target_form() {
  return { id: 'officePc', host: 'pc.example.test', port: 21119, user: 'tester', password: 'fake-password',
    description: '测试电脑', enabled: true, trustConfirmed: true,
    hostKeySha256: `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}` }
}

test('保存与读取脱敏，密码留空保留，不改动原有账号', t => {
  const store = make_store(t)
  store.write_json('secrets.json', { qq: { clientSecret: 'fake-qq-secret' } })
  const saved = store.save_target(target_form())
  assert.equal(saved.targets[0].hasCredential, true)
  assert.ok(!JSON.stringify(saved).includes('fake-password'))
  store.save_target({ ...target_form(), password: '', trustConfirmed: false })
  const secrets = store.read_json('secrets.json')
  assert.equal(secrets.remoteControl.targets.officePc.password, 'fake-password')
  assert.equal(secrets.qq.clientSecret, 'fake-qq-secret')
  assert.ok(!readFileSync(join(store.project, 'config', 'remoteControl.json'), 'utf8').includes('fake-password'))
})

test('首次信任与修改主机均必须明确核对指纹', t => {
  const store = make_store(t)
  assert.throws(() => store.save_target({ ...target_form(), trustConfirmed: false }), /核对/)
  store.save_target(target_form())
  assert.throws(() => store.save_target({ ...target_form(), host: 'other.example.test', trustConfirmed: false }), /核对/)
})

test('无凭据不能启用，禁止路径和 URL 作为目标', t => {
  const store = make_store(t)
  assert.throws(() => store.save_target({ ...target_form(), password: '' }), /密码/)
  for (const value of [{ id: '../escape' }, { host: 'https://example.test' }, { port: 0 }, { port: 1.2 }]) {
    assert.throws(() => store.save_target({ ...target_form(), ...value }))
  }
})

test('损坏 secrets 不会被空配置覆盖，报错不回显密码', t => {
  const store = make_store(t)
  const file = join(store.project, 'config', 'secrets.json')
  writeFileSync(file, '{"secret":"fake-secret"', 'utf8')
  assert.throws(() => store.save_target(target_form()))
  assert.equal(readFileSync(file, 'utf8'), '{"secret":"fake-secret"')
})

test('删除仅影响所选本机配置，不触发远程执行', async t => {
  let calls = 0
  const store = make_store(t, async () => { calls += 1 })
  store.save_target(target_form())
  store.delete_target('officePc')
  assert.equal(store.list_targets().targets.length, 0)
  assert.equal(store.read_json('secrets.json').remoteControl.targets.officePc, undefined)
  assert.equal(calls, 0)
})

test('只探测已启用电脑，固定动作且不传密码，并发有界', async t => {
  const pending = []
  const store = make_store(t, body => new Promise(done => { assert.equal(body.password, undefined); pending.push(done) }))
  await assert.rejects(store.probe_target({ action: 'probe', target: 'missing' }), /保存/)
  store.save_target(target_form())
  const first = store.probe_target({ action: 'probe', target: 'officePc' })
  const second = store.probe_target({ action: 'peekKey', host: 'pc.example.test', port: 22 })
  await assert.rejects(store.probe_target({ action: 'probe', target: 'officePc' }), /稍候/)
  for (const done of pending) done({ ok: true })
  await Promise.all([first, second])
  assert.equal(store.active, 0)
})

test('真实 HTTP 路由拒绝跨站、非 JSON 与过大的请求', async t => {
  const store = make_store(t)
  const routes = new RemoteConnectionRoutes(store)
  const server = createServer((req, res) => {
    if (!routes.handle_request(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  routes.port = server.address().port
  const base = `http://127.0.0.1:${routes.port}`
  let reply = await fetch(base + '/api/remote/targets', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(target_form()) })
  assert.equal(reply.status, 403)
  reply = await fetch(base + '/api/remote/targets', { method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(target_form()) })
  assert.equal(reply.status, 403)
  reply = await fetch(base + '/api/remote/targets', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target_form()) })
  assert.equal(reply.status, 200)
  assert.ok(!(await reply.text()).includes('fake-password'))
  reply = await fetch(base + '/api/remote/targets', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(40000) })
  assert.equal(reply.status, 400)
})

test('共享服务健康检查使用保存的密钥，HTTP 401 仍为不可用', async () => {
  let auth
  const probe = new ServiceProbe({ env: {}, secret: () => 'fake-key', fetcher: async (url, options) => {
    auth = options.headers.Authorization
    return new Response('{"ok":true}', { status: 200 })
  } })
  const result = await probe.probe_service('tts', { baseURL: 'https://service.example.test/v1',
    management: 'external', apiKeyRef: 'backendService' })
  assert.equal(auth, 'Bearer fake-key')
  assert.equal(result.available, true)
  probe.fetcher = async () => new Response('', { status: 401 })
  assert.equal((await probe.probe_service('tts', { baseURL: 'https://service.example.test/v1', management: 'external' })).available, false)
})

test('主页远程卡片仅使用新鲜协议证据，过期与配置版本不符立即失效', async t => {
  const store = make_store(t)
  store.save_target(target_form())
  const dashboard = new DashboardStore({ project: store.project })
  assert.equal(dashboard.remote_channel().status, 'unverified')
  await store.probe_target({ action: 'probe', target: 'officePc' })
  assert.equal(dashboard.remote_channel().status, 'connected')
  store.save_probe_status('officePc', true, 'old-version')
  assert.equal(dashboard.remote_channel().status, 'unverified')
  const file = join(store.project, 'runtime', 'remoteControl', 'channelStatus.json')
  writeFileSync(file, JSON.stringify({ officePc: { available: true, version: store.config_version(), checkedAt: Date.now() - 61000 } }))
  assert.equal(dashboard.remote_channel().status, 'unverified')
})
