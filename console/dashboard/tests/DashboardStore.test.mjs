/**
 * DashboardStore 只读聚合测试：临时数据库和探针隔离验证通道证据、任务缓存与后台动态。
 * 默认不访问生产目录、不查询 Windows 服务、不连接任何模型或消息平台。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { DashboardStore } from '../DashboardStore.mjs'

test('新闻服务已启用时覆盖旧 Windows 停用状态且只显示一个任务', async t => {
  const f = fixture(t)
  f.store.tasks = async () => [{ id: 'SynLoveNewsDigest', state: 'Disabled', triggers: [] }]
  f.store.digestSnapshot = async () => ({ schedule: { hhmm: '08:55', enabled: 1, day: '2026-11-02' } })
  const result = await f.store.snapshot()
  const rows = result.schedules.filter(row => row.name === '每日新闻')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'Ready')
  assert.equal(rows[0].source, '爬虫中心')
  assert.equal(rows[0].nextLabel, '08:55')
  assert.ok(!result.schedules.some(row => row.id === 'SynLoveNewsDigest'))
})

test('新闻计划真的关闭时显示停用，查询失败显示未知而不沿用旧任务', async t => {
  const f = fixture(t)
  f.store.digestSnapshot = async () => ({ schedule: { hhmm: '08:55', enabled: 0 } })
  assert.equal((await f.store.news_schedule()).status, 'Disabled')
  f.store.digestSnapshot = async () => { throw new Error('fake offline') }
  assert.equal((await f.store.news_schedule()).status, 'Unknown')
})

/** 参数 t：测试上下文；构造临时状态和真实消费者证据，结束时仅清理此临时目录。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synloveDashboard-'))
  const home = join(root, 'home')
  const runtime = join(root, 'runtime')
  mkdirSync(home)
  mkdirSync(runtime)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = new DatabaseSync(join(home, 'weixin-state.db'))
  state.exec('CREATE TABLE consumer_lease (id INTEGER PRIMARY KEY, pid INTEGER, process_started_at INTEGER, heartbeat_at INTEGER)')
  const now = Date.now()
  state.prepare('INSERT INTO consumer_lease VALUES(1,?,?,?)').run(process.pid, now - 10_000, now)
  state.close()
  writeFileSync(join(home, 'qq-gateway.pid'), String(process.pid))
  const probe = join(runtime, 'weixin-probe.log')
  writeFileSync(probe, [
    { at: new Date(now - 1000).toISOString(), scope: 'ingress', event: 'poll.idle' },
    { at: new Date(now - 1000).toISOString(), scope: 'lifecycle', event: 'qq.gateway', data: { message: 'gateway READY' } },
    { at: new Date(now - 1000).toISOString(), scope: 'timeline', event: 'scheduler.started', data: { interval_ms: 300000 } },
  ].map(JSON.stringify).join('\n') + '\n')
  const store = new DashboardStore({ project: root, home, credentials: () => ({ weixin: true, qq: true }), tasks: async () => [] })
  return { root, home, runtime, probe, store }
}

test('现有租约和 READY 证明已连接，读取不改变业务数据库', async t => {
  const f = fixture(t)
  const before = readFileSync(join(f.home, 'weixin-state.db'))
  const result = await f.store.snapshot()
  assert.deepEqual(result.channels.slice(0, 2).map(row => row.status), ['connected', 'connected'])
  assert.ok(result.schedules.some(row => row.id === 'maintenance-timeline'))
  assert.deepEqual(readFileSync(join(f.home, 'weixin-state.db')), before)
})

test('增量探针及时反映微信鉴权失败和 QQ 断线', async t => {
  const f = fixture(t)
  await f.store.snapshot()
  appendFileSync(f.probe, [
    { at: new Date().toISOString(), scope: 'ingress', event: 'poll.auth_required' },
    { at: new Date().toISOString(), scope: 'lifecycle', event: 'qq.gateway', data: { message: 'gateway 断开，1s 后重连' } },
  ].map(JSON.stringify).join('\n') + '\n')
  const result = await f.store.snapshot()
  assert.deepEqual(result.channels.slice(0, 2).map(row => row.status), ['auth', 'reconnecting'])
})

test('陈旧租约与旧进程的 READY 不能标成已连接', async t => {
  const f = fixture(t)
  const db = new DatabaseSync(join(f.home, 'weixin-state.db'))
  db.exec(`UPDATE consumer_lease SET heartbeat_at = ${Date.now() - 300_000}`)
  db.close()
  const result = await f.store.snapshot()
  assert.equal(result.channels[0].status, 'offline')
  assert.notEqual(result.channels[1].status, 'connected')
})

test('探针换文件后清除旧 READY，不沿用过期连接证据', async t => {
  const f = fixture(t)
  await f.store.snapshot()
  writeFileSync(f.probe, JSON.stringify({ at: new Date().toISOString(), scope: 'ingress', event: 'poll.idle' }) + '\n')
  const result = await f.store.snapshot()
  assert.notEqual(result.channels[1].status, 'connected')
})

test('用户提醒和推送记录按真实字段展示，失败推送不能说成功', async t => {
  const f = fixture(t)
  const reminders = new DatabaseSync(join(f.runtime, 'reminders.db'))
  reminders.exec("CREATE TABLE reminders(id INTEGER, text TEXT, next_at TEXT, daily_at TEXT, status TEXT, fired_at TEXT); INSERT INTO reminders VALUES (1,'吃药','2026-10-31 12:00:00','12:00','pending',NULL)")
  reminders.close()
  const news = new DatabaseSync(join(f.runtime, 'newsDigest.db'))
  news.exec("CREATE TABLE pushes(id INTEGER, created_at TEXT, channel TEXT, ok INTEGER); INSERT INTO pushes VALUES(1,'2026-10-30 08:00:00','qq',0)")
  news.close()
  const result = await f.store.snapshot()
  assert.equal(result.reminderTotal, 1)
  assert.equal(result.schedules.find(row => row.id === 'reminder-1').rule, '每天 12:00')
  assert.ok(result.activities.some(row => row.text === '新闻推送失败 · QQ'))
})

test('系统计划任务查询合并并发且缓存，维护任务归系统页', async t => {
  const f = fixture(t)
  let calls = 0
  f.store.tasks = async () => {
    calls++
    return [
      { id: 'SynLoveNewsDigest', state: 'Ready', nextAt: '2026-10-31T08:55:00+08:00', triggers: [{ start: '2026-10-27T08:55:00+08:00' }] },
      { id: 'SynLoveGuard', state: 'Ready', triggers: [{ interval: 'PT5M' }] },
    ]
  }
  const results = await Promise.all(Array.from({ length: 12 }, () => f.store.snapshot()))
  assert.equal(calls, 1)
  assert.equal(results[0].systemTasks.length, 1)
  assert.ok(results[0].schedules.some(row => row.name === '每日新闻'))
  assert.ok(!results[0].schedules.some(row => row.id === 'SynLoveGuard'))
})

test('缺数据库不创建文件，查询故障明确给出错误', async t => {
  const f = fixture(t)
  f.store.tasks = async () => { throw new Error('isolated failure') }
  const result = await f.store.snapshot()
  assert.ok(result.errors.includes('系统计划任务暂不可用'))
  assert.equal(existsSync(join(f.runtime, 'reminders.db')), false)
  assert.equal(existsSync(join(f.runtime, 'newsDigest.db')), false)
})

test('酷狗状态来自实际探测结果，关闭功能时不发探测请求', async t => {
  const f = fixture(t)
  const config = join(f.root, 'kugou', 'config')
  mkdirSync(config, { recursive: true })
  const file = join(config, 'kugou.json')
  writeFileSync(file, JSON.stringify({ enabled: true, apiBase: 'http://music.example.test' }))
  let calls = 0
  f.store.musicProbe = async url => { calls++; assert.equal(url.hostname, 'music.example.test'); return true }
  assert.equal((await f.store.music_channel()).status, 'connected')
  f.store.musicProbe = async () => { throw new Error('offline') }
  assert.equal((await f.store.music_channel()).status, 'offline')
  writeFileSync(file, JSON.stringify({ enabled: false }))
  assert.equal((await f.store.music_channel()).status, 'disabled')
  assert.equal(calls, 1)
})
