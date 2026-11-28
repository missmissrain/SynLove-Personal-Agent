/**
 * 远程会话集成测试：真实 Node HTTP 服务、真实持久化插件、临时目录，无模型及消息平台调用。
 * 默认注册参数由测试生成：随机回环端口、独立数据根和 1 秒请求超时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '../backend/vendor/cordis/lib/index.js'
import JsonlSessionPersistence from '../backend/packages/session/session-persistence-jsonl/lib/index.js'

test('远程单写者、只读权限、连续序号、服务重启恢复、断线不落本地和跨站停服防护', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synlove-session-'))
  const local = path.join(root, 'must-not-exist')
  const portServer = net.createServer()
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve))
  const port = portServer.address().port
  await new Promise(resolve => portServer.close(resolve))
  const url = `http://127.0.0.1:${port}`
  const keys = ['SYNLOVE_SESSION_MODE', 'SYNLOVE_SESSION_BASE_URL', 'SYNLOVE_SESSION_TIMEOUT_MS', 'SYNLOVE_SESSION_API_KEY']
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  let child
  let ctx
  /** 无参数；启动独立临时服务，等待实际身份探活。 */
  async function start_server() {
    child = spawn(process.execPath, ['backend/tools/sessionServiceServer.mjs'], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SYNLOVE_SESSION_ROOT: path.join(root, 'server'),
        SYNLOVE_SESSION_PORT: String(port), SYNLOVE_SESSION_API_KEY: '', SYNLOVE_SESSION_MODE: 'remote' },
    })
    let error = ''
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000) })
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`临时服务退出：${error}`)
      try {
        const data = await (await fetch(url + '/health')).json()
        if (data.service === 'session') return
      } catch {}
      await delay(100)
    }
    throw new Error('临时服务启动超时')
  }
  /** 无参数；停止当前测试持有的进程并等待退出。 */
  async function stop_server() {
    if (!child || child.exitCode !== null) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await exited
  }
  try {
    await start_server()
    process.env.SYNLOVE_SESSION_MODE = 'remote'
    process.env.SYNLOVE_SESSION_BASE_URL = url + '/v1'
    process.env.SYNLOVE_SESSION_TIMEOUT_MS = '1000'
    delete process.env.SYNLOVE_SESSION_API_KEY
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root: local, compression: 'zstd' })
    const store = ctx.sessionPersistence
    const writer = await store.create({ version: 3, id: 'fixture', createdAt: Date.now(),
      isSeeded: false, delegationDepth: 0 })
    await writer.append([{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
    await writer.flush()
    await assert.rejects(store.open('fixture', 'write'), /already owned/)
    const reader = await store.open('fixture', 'read')
    await assert.rejects(reader.append([{ type: 'turn/end', seq: 1, time: 2, data: {} }]), /read handle/)
    await assert.rejects(writer.append([{ type: 'turn/end', seq: 2, time: 2, data: {} }]), /seq mismatch/)
    assert.equal((await reader.read(0, 10)).events.length, 1)
    await reader.close()
    await writer.close()
    const denied = await fetch(url + '/v1/shutdown', { method: 'POST',
      headers: { Origin: 'https://fixture.invalid', 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(denied.status, 403)
    await stop_server()
    await assert.rejects(store.stat('fixture'))
    await assert.rejects(fs.access(local), { code: 'ENOENT' })
    await start_server()
    const recovered = await store.open('fixture', 'read')
    assert.equal((await recovered.read(0, 10)).events.length, 1)
    await recovered.close()
  } finally {
    if (ctx) await ctx.fiber.dispose()
    await stop_server()
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k]
      else process.env[k] = before[k]
    }
    // 临时根只由本测试创建，成功或失败均清理，不接触生产会话。
    await fs.rm(root, { recursive: true, force: true })
  }
})
