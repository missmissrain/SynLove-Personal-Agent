/**
 * 远程页浏览器冒烟：真实页面、临时配置、假 SSH 响应及真实管理路由。
 * 参数 argv[2] 为已安装 Playwright 模块，argv[3] 为浏览器可执行文件；
 * 截图输出 runtime/remoteControl/界面验证，不访问正式服务或发送真实消息。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { RemoteConnectionStore } from '../RemoteConnectionStore.mjs'
import { RemoteConnectionRoutes } from '../RemoteConnectionRoutes.mjs'
import { DashboardStore } from '../../dashboard/DashboardStore.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.argv[2] || 'playwright')
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync(join(tmpdir(), 'synloveRemoteBrowser-'))
mkdirSync(join(root, 'config'))
mkdirSync(join(root, 'runtime'))
const fingerprint = `SHA256:${Buffer.alloc(32, 9).toString('base64').replace(/=+$/, '')}`
const store = new RemoteConnectionStore({ project: root, runner: async body =>
  body.action === 'peekKey' ? { ok: true, fingerprint, message: '请在目标电脑核对指纹后保存' } :
    { ok: true, available: true, message: 'SSH 身份、登录与 CMD 协议验证通过' } })
const routes = new RemoteConnectionRoutes(store)
const dashboard = new DashboardStore({ project: root, home: join(root, 'home'),
  tasks: async () => [{ id: 'SynLoveNewsDigest', state: 'Disabled' }],
  digestSnapshot: async () => ({ schedule: { enabled: 1, hhmm: '08:55' } }) })
const backend = { mode: 'local', host: '127.0.0.1', scanRadius: 1, services: {
  tts: { defaultPort: 7862, label: 'TTS' }, asr: { defaultPort: 8081, label: 'ASR' }, llm: { defaultPort: 8080, label: 'LLM' },
} }
let backendKey = ''
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (routes.handle_request(req, res, url)) return
  let data
  if (url.pathname === '/api/dashboard') data = await dashboard.snapshot()
  else if (url.pathname === '/api/overview') data = { services: [], outbox: [], memory: {}, deliveries: 0 }
  else if (url.pathname.startsWith('/api/backend')) {
    if (req.method === 'POST') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      if (body.apiKey) backendKey = body.apiKey
      for (const name of ['mode', 'host', 'protocol']) if (body[name]) backend[name] = body[name]
    }
    data = { ok: true, config: backend, hasApiKey: Boolean(backendKey) }
  } else if (url.pathname.startsWith('/api/')) data = { error: '隔离验证，不调用生产接口' }
  else {
    const file = resolve(project, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    if (!file.startsWith(join(project, 'public')) || !existsSync(file)) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' :
      file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/javascript')
    res.end(readFileSync(file))
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
})

let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  routes.port = server.address().port
  browser = await chromium.launch({ headless: true, executablePath: process.argv[3] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${routes.port}`)
  await page.locator('[data-channel="remote"]').waitFor()
  assert.match(await page.locator('#dashboard-schedules').innerText(), /新闻服务/)
  assert.doesNotMatch(await page.locator('#dashboard-schedules').innerText(), /已停用/)
  await page.locator('[data-channel="remote"]').click()
  assert.equal(await page.locator('#tab-remote').isVisible(), true)
  assert.equal(await page.locator('#page-title').innerText(), '远程连接')
  assert.equal(await page.locator('#tab-system .backend-config-card').count(), 0)
  await page.locator('#remote-id').fill('officePc')
  await page.locator('#remote-description').fill('办公室电脑')
  await page.locator('#remote-host').fill('pc.example.test')
  await page.locator('#remote-port').fill('21119')
  await page.locator('#remote-user').fill('tester')
  await page.locator('#remote-password').fill('fake-password')
  await page.locator('#remote-key').click()
  await page.waitForFunction(() => document.getElementById('remote-fingerprint').value.startsWith('SHA256:'))
  assert.equal(await page.locator('#remote-trust').isChecked(), false)
  await page.locator('#remote-save').click()
  await page.waitForFunction(() => document.getElementById('remote-result').textContent.includes('勾选确认'))
  await page.locator('#remote-trust').check()
  await page.locator('#remote-save').click()
  await page.waitForFunction(() => document.getElementById('remote-result').textContent.includes('已保存'))
  assert.equal(await page.locator('#remote-password').inputValue(), '')
  await page.locator('#remote-test').click()
  await page.waitForFunction(() => document.getElementById('remote-result').textContent.includes('协议验证通过'))
  assert.equal(await page.locator('#remote-target-list .is-up').count(), 1)
  await page.locator('#remote-description').fill('工作电脑')
  await page.locator('#remote-save').click()
  await page.waitForFunction(() => document.getElementById('remote-result').textContent.includes('已保存'))
  assert.equal(store.read_json('secrets.json').remoteControl.targets.officePc.password, 'fake-password')
  const response = await page.request.get(`http://127.0.0.1:${routes.port}/api/remote/targets`)
  assert.ok(!(await response.text()).includes('fake-password'))
  await page.locator('#backend-mode').selectOption('remote')
  await page.locator('#backend-host').fill('services.example.test')
  await page.locator('#backend-key').fill('fake-api-key')
  await page.locator('#backend-save').click()
  await page.waitForFunction(() => document.getElementById('backend-hint').textContent.startsWith('已保存'))
  assert.equal(backendKey, 'fake-api-key')
  assert.equal(await page.locator('#backend-key').inputValue(), '')
  const output = join(project, '..', 'runtime', 'remoteControl', '界面验证')
  mkdirSync(output, { recursive: true })
  await page.screenshot({ path: join(output, '远程连接配置.png'), fullPage: true })
  await page.locator('[data-tab="overview"]').click()
  await page.locator('[data-channel="remote"]').waitFor()
  await page.screenshot({ path: join(output, '主页远程入口.png'), fullPage: true })
  await page.locator('[data-channel="remote"]').click()
  await page.setViewportSize({ width: 1280, height: 720 })
  assert.ok(await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
  await page.locator('#remote-delete').click()
  await page.waitForFunction(() => document.getElementById('remote-result').textContent.includes('已删除'))
  assert.equal(store.list_targets().targets.length, 0)
  assert.deepEqual(errors, [])
  console.log('PASS: 主页远程入口、新闻已启用、配置保存、指纹确认、密码不回填、测试连接、服务密钥与删除')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
