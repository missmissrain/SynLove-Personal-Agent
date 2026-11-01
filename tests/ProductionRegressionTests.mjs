/**
 * 生产修复回归：验证真实会话宿主缺失恢复、失败边界及 QQ 鉴权心跳顺序。
 * 参数：node --experimental-transform-types --test tests/ProductionRegressionTests.mjs；使用假网络和定时器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HarnessSessionHost } from '../backend/packages/webhook/webhook-weixin/src/session/weixinSessionHost.ts'
import { QqGateway } from '../backend/packages/webhook/webhook-qq/src/gateway.ts'

/** error 为恢复错误；提供与宿主一致的假接口并记录创建次数。 */
function make_host(error) {
  let creates = 0
  const agent = { id: 'fixture-main' }
  const handle = { agent, dispose: async () => {} }
  const ctx = {
    get: () => ({ resolve: async () => ({ id: 'fixture' }), mount: async () => {} }),
    agents: {
      resume: async () => { if (error) throw error; return handle },
      create: async () => { creates++; return handle },
    },
  }
  const host = new HarnessSessionHost(ctx, { workspace_path: '.', provider: 'fixture', model: 'fixture' })
  return { host, agent, creates: () => creates }
}

test('共享名称对应会话缺失时创建一次', async () => {
  const state = make_host(new Error('session "fixture-main" not found'))
  assert.equal(await state.host.resume_agent('fixture-main'), state.agent)
  assert.equal(state.creates(), 1)
})

test('已有会话直接恢复，不能覆盖历史', async () => {
  const state = make_host()
  assert.equal(await state.host.resume_agent('fixture-main'), state.agent)
  assert.equal(state.creates(), 0)
})

test('损坏、权限、写入占用、预设挂载失败必须保留错误', async () => {
  for (const message of ['corrupt session log', 'EACCES', 'already owned by active write handle', 'preset failed to mount']) {
    const state = make_host(new Error(message))
    await assert.rejects(state.host.resume_agent('fixture-main'), { message })
    assert.equal(state.creates(), 0)
  }
})

test('QQ 先鉴权，READY后携带序号心跳，ACK持续时不重连，失ACK后单次重连', async t => {
  const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket }
  const sockets = []
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    sent = []
    listeners = new Map()
    /** 无参数；保存假连接，不联网。 */
    constructor() { sockets.push(this) }
    /** name/fn 为事件及处理器；保存监听。 */
    addEventListener(name, fn) { this.listeners.set(name, fn) }
    /** raw 为协议帧；记录消息。 */
    send(raw) { this.sent.push(JSON.parse(raw)) }
    /** 无参数；模拟同步关闭事件，验证连接代次隔离。 */
    close() { this.readyState = 3; this.listeners.get('close')?.({}) }
    /** frame 为服务器协议；驱动真实网关解析。 */
    emit_frame(frame) { this.listeners.get('message')?.({ data: JSON.stringify(frame) }) }
  }
  globalThis.WebSocket = FakeSocket
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ url: 'wss://fixture.invalid' }) })
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const gateway = new QqGateway({ token: async () => 'fixture', on_event: () => {} })
  try {
    gateway.start()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const socket = sockets[0]
    socket.emit_frame({ op: 10, d: { heartbeat_interval: 1000 } })
    await Promise.resolve()
    assert.deepEqual(socket.sent.map(x => x.op), [2])
    socket.emit_frame({ op: 0, t: 'READY', s: 7, d: { session_id: 'fixture' } })
    assert.deepEqual(socket.sent.at(-1), { op: 1, d: 7 })
    for (let i = 0; i < 30; i++) {
      socket.emit_frame({ op: 11 })
      t.mock.timers.tick(1000)
    }
    assert.equal(sockets.length, 1)
    t.mock.timers.tick(1000)
    assert.equal(socket.readyState, 3)
    gateway.stop()
    t.mock.timers.tick(10000)
    assert.equal(sockets.length, 1)
  } finally {
    gateway.stop()
    globalThis.fetch = original.fetch
    globalThis.WebSocket = original.WebSocket
    t.mock.timers.reset()
  }
})
