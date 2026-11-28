/**
 * GUI终端桥接隔离测试：验证权威设备读取、单次派单及管理端点限制。
 * 无注册参数；仅使用随机回环端口和临时配置，不启动SynLove、不使用真实凭据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalConnectionStore } from '../console/remote/TerminalConnectionStore.mjs'
import { TerminalConnectionRoutes } from '../console/remote/TerminalConnectionRoutes.mjs'
import { DashboardStore } from '../console/dashboard/DashboardStore.mjs'

/** handler为测试HTTP逻辑，run为测试主体；使用临时配置并确保测试监听器被关闭。 */
async function with_manager(handler, run) {
  const root = mkdtempSync(join(tmpdir(), 'synloveGuiTest'))
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer isolatedTest')
    handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'config/terminalConnection.json'), JSON.stringify({
    adminURL: `http://127.0.0.1:${server.address().port}`, adminToken: 'isolatedTest',
  }))
  try { await run(new TerminalConnectionStore({ project: root }), root) }
  finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
}

test('设备列表来自管理器且不返回管理凭据', async () => {
  await with_manager((req, res) => {
    const reply = req.url === '/v1/devices'
      ? { ok: true, devices: [{ id: 'first', online: true }, { id: 'second', online: false }] }
      : req.url === '/v1/health'
        ? { ok: true, relayConnected: true, notificationsConfigured: true } : { ok: true, kinds: ['android'], transports: [] }
    res.end(JSON.stringify(reply))
  }, async store => {
    const data = await store.list_devices()
    assert.equal(data.onlineCount, 1)
    assert.equal(data.relayConnected, true)
    assert.equal(data.notificationsConfigured, true)
    assert.ok(!JSON.stringify(data).includes('isolatedTest'))
  })
})

test('通知目的地未就绪时明确返回false，不从设备在线推断可送达', async () => {
  await with_manager((req, res) => {
    const reply = req.url === '/v1/devices'
      ? { ok: true, devices: [{ id: 'first', online: true }] }
      : req.url === '/v1/health'
        ? { ok: true, relayConnected: true } : { ok: true, kinds: [], transports: [] }
    res.end(JSON.stringify(reply))
  }, async store => {
    const data = await store.list_devices()
    assert.equal(data.onlineCount, 1)
    assert.equal(data.notificationsConfigured, false)
  })
})

test('探活只提交一次并查询同一指令结果', async () => {
  let posts = 0, polls = 0
  await with_manager((req, res) => {
    if (req.method === 'POST') { posts++; res.end(JSON.stringify({ ok: true, id: 'probeId' })) }
    else {
      assert.equal(req.url, '/v1/commands/probeId')
      polls++
      res.end(JSON.stringify({ ok: true, state: polls > 1 ? 'done' : 'queued',
        result: { ok: true, protocol: 'synlove-terminal-v1' } }))
    }
  }, async store => {
    const reply = await store.probe_device('first')
    assert.equal(reply.available, true)
    assert.equal(posts, 1)
    assert.equal(polls, 2)
  })
})

test('预登记仅转发登记字段，不能声明在线或注入公钥', async () => {
  await with_manager((req, res) => {
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      const data = JSON.parse(text)
      assert.equal(req.url, '/v1/device/reserve')
      assert.equal(data.kind, 'android')
      assert.equal(data.parentId, 'gateway')
      assert.equal(data.publicKey, undefined)
      assert.equal(data.online, undefined)
      res.end('{"ok":true}')
    })
  }, async store => {
    await store.register_device({ deviceId: 'phone', name: 'phone', kind: 'android',
      transport: 'adb', parentId: 'gateway', online: true, publicKey: 'untrusted' })
  })
})

test('管理端点拒绝非回环地址与内嵌认证参数', async () => {
  await with_manager((_req, res) => res.end('{"ok":true}'), async (store, root) => {
    for (const url of ['http://example.com', 'http://user:pass@127.0.0.1',
      'http://127.0.0.1/?token=untrusted', 'https://127.0.0.1']) {
      writeFileSync(join(root, 'config/terminalConnection.json'),
        JSON.stringify({ adminURL: url, adminToken: 'isolatedTest' }))
      assert.throws(() => store.read_bridge())
    }
  })
})

test('GUI路由拒绝跨站写入与外部Host', () => {
  const route = new TerminalConnectionRoutes({}, 3082)
  assert.equal(route.check_request({ method: 'POST', headers: {
    host: '127.0.0.1:3082', origin: 'https://example.com', 'content-type': 'application/json',
  } }), false)
  assert.equal(route.check_request({ method: 'GET', headers: { host: 'example.com:3082' } }), false)
  assert.equal(route.check_request({ method: 'POST', headers: {
    host: '127.0.0.1:3082', origin: 'http://127.0.0.1:3082', 'content-type': 'application/json',
  } }), true)
})

test('主页只统计新鲜终端心跳，旧SSH配置不再贡献在线数量', async () => {
  await with_manager((_req,res) => res.end('{"ok":true}'), async (_store,root) => {
    const file=join(root,'devices.json')
    writeFileSync(join(root,'config/terminalConnection.json'),JSON.stringify({deviceSnapshot:file}))
    const now=Date.now()/1000
    const devices=[
      {id:'first',online:true,enabled:1,lastSeen:now},
      {id:'second',online:true,enabled:1,lastSeen:now-65},
      {id:'reserved',online:false,enabled:1,lastSeen:0},
    ]
    writeFileSync(file,JSON.stringify({checkedAt:now,devices}))
    const dashboard=new DashboardStore({project:root,home:join(root,'runtime')})
    assert.equal(dashboard.remote_channel().label,'1 台在线')
    writeFileSync(file,JSON.stringify({checkedAt:now-16,devices}))
    assert.equal(dashboard.remote_channel().label,'0 台在线')
    assert.equal(dashboard.remote_channel().status,'unverified')
  })
})
