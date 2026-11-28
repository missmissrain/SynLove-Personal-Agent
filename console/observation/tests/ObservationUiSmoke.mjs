/**
 * GUI 冒烟与截图：加载真实页面与隔离元数据，验证筛选、调用树、无评分界面、故障降级及手机布局。
 * 参数 argv[2]：Playwright 模块目录；argv[3]：浏览器可执行文件；argv[4]：中文截图输出目录。
 * 不连接生产控制台、不调用模型、不发微信、不启动后端守护。
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { ObservationStore } from '../ObservationStore.mjs'
import { ObservationRoutes } from '../ObservationRoutes.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.argv[2] || 'playwright')
const output = resolve(process.argv[4] || join(dirname(fileURLToPath(import.meta.url)), '界面验证'))
const root = await mkdtemp(join(tmpdir(), 'synloveObservationUi-'))
const runtime = join(root, 'runtime')
const config = join(root, 'config')
await mkdir(runtime)
await mkdir(config)
await mkdir(output, { recursive: true })
const records = []
for (let i = 1; i <= 12; i++) {
  const traceId = i.toString(16).padStart(32, 'a')
  const rootSpan = i.toString(16).padStart(16, 'b')
  const modelSpan = i.toString(16).padStart(16, 'c')
  const relaySpan = i.toString(16).padStart(16, 'd')
  const nodeSpan = i.toString(16).padStart(16, 'e')
  const at = Date.now() - (i % 5) * 86_400_000 - 60_000 * i
  const common = { traceId, sessionId: `界面验证会话-${Math.ceil(i / 3)}`, at: new Date(at).toISOString() }
  const end = { ...common, at: new Date(at + 3450).toISOString() }
  records.push(
    { ...common, spanId: rootSpan, kind: 'turn', phase: 'start', name: '用户轮次' },
    { ...common, spanId: modelSpan, parentSpanId: rootSpan, kind: 'model', phase: 'start', name: 'doubao-seed-2.0-lite', model: i % 2 ? 'doubao-seed-2.0-lite' : 'gemma-local', provider: 'fixture', promptVersion: (i % 2 ? '1' : '2').repeat(64), toolsVersion: '3'.repeat(64) },
    { ...common, spanId: relaySpan, parentSpanId: modelSpan, kind: 'relay', phase: 'start', name: 'VPS · chat' },
    { ...common, spanId: nodeSpan, parentSpanId: relaySpan, kind: 'node', phase: 'start', name: '家庭节点 · chat' },
    { ...end, spanId: nodeSpan, parentSpanId: relaySpan, kind: 'node', phase: 'end', status: 'ok', durationMs: 2080 },
    { ...end, spanId: relaySpan, parentSpanId: modelSpan, kind: 'relay', phase: 'end', status: 'ok', durationMs: 2340 },
    { ...end, spanId: modelSpan, parentSpanId: rootSpan, kind: 'model', phase: 'end', status: i === 4 ? 'error' : 'ok', model: i % 2 ? 'doubao-seed-2.0-lite' : 'gemma-local', provider: 'fixture', promptVersion: (i % 2 ? '1' : '2').repeat(64), toolsVersion: '3'.repeat(64), durationMs: 2810, ttftMs: 320, usage: { inputTokens: 1800, outputTokens: 130, totalTokens: 1930 } },
    { ...end, spanId: rootSpan, kind: 'turn', phase: 'end', status: i === 4 ? 'error' : 'ok' },
  )
}
await writeFile(join(runtime, 'observations.jsonl'), records.map(JSON.stringify).join('\n') + '\n')
const store = new ObservationStore({ runtime, config })
const publicPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../public')
let routes
let usageUnavailable = false
let dashboardUnavailable = false
const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (routes.handle(req, res, url)) return
    let data
    if (url.pathname === '/api/overview') data = { services: [
      { name: '微信通道（界面验证数据）', up: true, port: 3081 },
      { name: 'LLM', up: true, port: 8080, endpoint: 'https://model.example.test/v1', management: '外部服务', detail: 'HTTP 200' },
      { name: 'TTS', up: false, available: true, readiness: 'standby', port: 7862, endpoint: 'http://127.0.0.1:7862/v1', management: '本机托管', detail: '可按需调用' },
    ], deliveries: 36, outbox: [], memory: { timeline_days: 14, graph: 8, last_day: '2026-10-30' } }
    else if (url.pathname === '/api/usage') {
      if (usageUnavailable) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '用量探针暂不可用' })); return }
      data = { total: { input: 12000, cacheRead: 24000, output: 6000, totalTokens: 42000, calls: 6 }, days: [], by_model: [] }
    }
    else if (url.pathname === '/api/models') data = {
      default: { provider: 'fixture', model: 'fixture-model' },
      providers: [{ id: 'fixture', models: [{ id: 'fixture-model', name: '界面验证模型' }] }],
    }
    else if (url.pathname === '/api/dashboard') {
      if (dashboardUnavailable) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '后台动态暂不可用' })); return }
      data = {
        at: new Date().toISOString(),
        activities: [
          { at: new Date().toISOString(), text: '技能复盘完成 · 新增 1 项' },
          { at: new Date().toISOString(), text: '新闻推送成功 · QQ' },
          { at: new Date().toISOString(), text: '<img src=x onerror=alert(1)>技能文件更新' },
        ],
        channels: [
          { id: 'weixin', tab: 'weixin', name: '微信', status: 'connected', label: '已连接', detail: '单消费者租约有效，最近轮询正常' },
          { id: 'qq', tab: 'qq', name: 'QQ 机器人', status: 'connected', label: '已连接', detail: '现有网关已完成 READY 握手' },
          { id: 'kugou', tab: 'agent', name: '酷狗音乐', status: 'connected', label: '已连接', detail: '音乐服务可连接' },
        ],
        schedules: [
          { id: 'reminder-1', name: '提醒测试', nextAt: '2026-10-31T12:00:00+08:00', rule: '每天 12:00', source: '用户提醒', status: 'pending' },
          { id: 'SynLoveSkillReview', name: '技能复盘', nextAt: '2026-10-31T03:00:00+08:00', rule: '每天 03:00', source: '系统计划任务', state: 'Ready' },
        ],
        systemTasks: [{ id: 'SynLoveGuard', name: '后台健康巡检', rule: '每 5 分钟', source: '系统计划任务', state: 'Ready' }],
        errors: [], reminderTotal: 1,
      }
    }
    else if (url.pathname.startsWith('/api/')) data = { error: '隔离的界面验证环境' }
    else {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (!['index.html', 'app.js', 'observation.js', 'ConsoleDashboard.js', 'ConsoleTooltip.js', 'DesktopChrome.js', 'OpeningScreen.js', 'OpeningPlayback.js', 'ConsoleTheme.css', 'style.css', 'assets/BrandIcon.png', 'assets/BrandTitle.png'].includes(name)) { res.writeHead(404); res.end(); return }
      res.setHeader('Content-Type', name.endsWith('png') ? 'image/png' : name.endsWith('html') ? 'text/html; charset=utf-8' : name.endsWith('css') ? 'text/css' : 'text/javascript')
      res.end(await readFile(join(publicPath, name)))
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })) }
})
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
routes = new ObservationRoutes(store, `http://127.0.0.1:${http.address().port}`)
const browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to apply/.test(message.text())) errors.push(message.text()) })
try {
  await page.goto(`http://127.0.0.1:${http.address().port}`)
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0))
  assert.equal(await page.title(), 'SynLove')
  assert.equal(await page.locator('.brand-caption').innerText(), '心合万象 爱有回响')
  assert.deepEqual(await page.locator('img').evaluateAll(images => images.map(image => image.getAttribute('src')).sort()),
    ['/assets/BrandIcon.png', '/assets/BrandTitle.png'], '只在侧栏使用品牌图标和标题图')
  await page.locator('#service-cards .service').first().waitFor()
  assert.doesNotMatch(await page.locator('.service-panel').innerText(), /https?:\/\/|端口|HTTP|本机托管|默认模型|最近探活/)
  assert.match(await page.locator('#service-cards').innerText(), /将文字合成为语音/)
  assert.equal(await page.locator('#service-cards .service-dot[aria-label="可按需调用"].is-up').count(), 1)
  await page.waitForFunction(() => document.querySelector('#dashboard-tokens').textContent === '42,000')
  assert.equal(await page.locator('#dashboard-deliveries').innerText(), '36')
  assert.equal(await page.locator('#dashboard-memory').innerText(), '14 天')
  assert.equal(await page.locator('#dashboard-token-chart meter').count(), 3)
  await page.waitForFunction(() => document.querySelectorAll('#dashboard-recent .activity-row').length === 3)
  assert.equal(await page.locator('#dashboard-recent img').count(), 0, '后台动态文本必须转义')
  assert.equal(await page.locator('.stat-card').first().evaluate(node => getComputedStyle(node).borderRadius), '12px')
  assert.equal(await page.locator('#tabs').evaluate(node => Math.round(node.getBoundingClientRect().width)), 200)
  assert.equal(await page.locator('#page-title').innerText(), '概览')
  await page.waitForFunction(() => document.querySelector('#current-model')?.textContent === 'fixture / fixture-model')
  assert.equal(await page.locator('#dashboard-channels .state-ok').count(), 3)
  assert.deepEqual(await page.locator('#dashboard-channels .connection-icon').allTextContents(), ['💬', '🐧', '🎵'])
  assert.equal(await page.locator('.channel-manage summary').innerText(), '管理 →')
  assert.equal(await page.locator('#dashboard-schedules .schedule-row').count(), 2)
  assert.equal(await page.locator('#outbox').isVisible(), false, '发送队列移出主页')
  assert.equal(await page.locator('#hb-detail').isVisible(), false, '守护卡片移出主页')
  await page.locator('[data-channel="qq"]').click()
  assert.equal(await page.locator('#tab-qq').isVisible(), true)
  await page.getByRole('button', { name: '系统', exact: true }).click()
  assert.equal(await page.locator('#outbox').isVisible(), true)
  assert.equal(await page.locator('#hb-detail').isVisible(), true)
  assert.match(await page.locator('#dashboard-system-tasks').innerText(), /后台健康巡检/)
  await page.screenshot({ path: join(output, '系统维护界面.png'), fullPage: true })
  await page.getByRole('button', { name: '概览', exact: true }).click()
  await page.screenshot({ path: join(output, '品牌首页.png'), fullPage: true })
  await page.getByRole('button', { name: '调用链', exact: true }).click()
  assert.equal(await page.locator('#page-title').innerText(), '调用链')
  assert.equal(await page.locator('#page-heading-title').innerText(), '调用链')
  await page.locator('#obs-list tbody tr').first().waitFor()
  assert.equal(await page.locator('#obs-list tbody tr').count(), 12)
  await page.locator('.trace-open').first().click()
  await page.locator('.span-row').first().waitFor()
  assert.equal(await page.locator('.span-row').count(), 4)
  assert.equal(await page.locator('#obs-score-form').count(), 0, '调用链不保留人工评分入口')
  assert.equal(await page.locator('#obs-detail img').count(), 0)
  await page.screenshot({ path: join(output, '调用链界面.png'), fullPage: true })
  await page.selectOption('#obs-status', 'error')
  await page.waitForFunction(() => document.querySelectorAll('#obs-list tbody tr').length === 1)
  await page.getByRole('button', { name: '运行趋势', exact: true }).click()
  await page.locator('#quality-versions tbody tr').first().waitFor()
  assert.equal(await page.locator('#quality-versions tbody tr').count(), 2)
  assert.doesNotMatch(await page.locator('#tab-quality').innerText(), /评分|人工均分|人工平均分/)
  assert.equal(await page.locator('#quality-versions th').count(), 5)
  await page.screenshot({ path: join(output, '运行趋势界面.png'), fullPage: true })
  await page.getByRole('button', { name: '概览', exact: true }).click()
  usageUnavailable = true
  await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#dashboard-token-note').textContent.includes('读取失败'))
  assert.equal(await page.locator('#dashboard-tokens').innerText(), '—', '服务失败不能显示旧值或假零值')
  assert.equal(await page.locator('#dashboard-deliveries').innerText(), '36', '独立区块不受用量接口故障影响')
  usageUnavailable = false
  await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#dashboard-tokens').textContent === '42,000')
  assert.equal(await page.locator('#page-heading-title').innerText(), '欢迎回来')
  dashboardUnavailable = true
  await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#dashboard-channels').textContent.includes('暂不可用'))
  assert.equal(await page.locator('#dashboard-channels .state-ok').count(), 0, '后台状态失败不能继续展示已连接')
  dashboardUnavailable = false
  await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('#dashboard-channels .state-ok').length === 3)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '概览手机视口不应溢出')
  await page.screenshot({ path: join(output, '手机概览界面.png'), fullPage: true })
  await page.getByRole('button', { name: '调用链', exact: true }).click()
  await page.locator('#obs-list tbody tr').first().waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '手机视口不应出现整页横向溢出')
  await page.screenshot({ path: join(output, '手机布局界面.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'PASS', assertions: 39, screenshots: output, javascriptErrors: errors.length }))
} finally {
  await browser.close()
  await new Promise(resolve => http.close(resolve))
  store.close()
  await rm(root, { recursive: true, force: true })
}
