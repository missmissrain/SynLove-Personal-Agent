/**
 * 真实业务HTTP、Hub、出站节点、Python客户端端到端测试。参数由环境提供现有解释器和Relay代码根。
 * 全部配置和数据库使用系统临时目录，模型与平台网络均不调用。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BusinessEndpoint } from '../console/dashboard/BusinessEndpoint.mjs'
import { ServiceProbe } from '../console/dashboard/ServiceProbe.mjs'

class BusinessRelayTests {
  /** 无参数；只解析既有仓库、依赖路径，临时目录保留供失败排查。 */
  constructor() {
    this.agent = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    this.backend = resolve(this.agent, '../SynLove-Backend-Service')
    this.temp = mkdtempSync(join(tmpdir(), 'SynLoveBusiness-'))
    this.children = []
    this.token = 'isolated-test-token'
    this.python = process.env.SYNLOVE_TEST_PYTHON || join(this.agent, '.venv/Scripts/python.exe')
  }

  /** command/args/cwd为固定测试程序；异步收集有界输出，失败不会阻塞HTTP事件循环。 */
  run_command(command, args, cwd, env = {}) {
    return new Promise((done, reject) => {
      const child = spawn(command, args, { cwd, windowsHide: true,
        env: { ...process.env, ...env, PYTHONUTF8: '1' } })
      let out = '', err = ''
      child.stdout.on('data', data => { out = (out + data).slice(-100000) })
      child.stderr.on('data', data => { err = (err + data).slice(-100000) })
      child.on('error', reject)
      child.on('exit', code => code === 0 ? done(out) : reject(Error(err + out)))
    })
  }

  /** 无参数；通过操作系统领取临时端口，用于真实服务子进程。 */
  async free_port() {
    const server = createServer()
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const port = server.address().port
    await new Promise(done => server.close(done))
    return port
  }

  /** fn为异步条件，timeout为毫秒；等待真实协议，不以启动命令成功为通过。 */
  async wait_until(fn, timeout = 10000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try { if (await fn()) return } catch {}
      await delay(100)
    }
    throw Error('等待协议超时')
  }

  /** 无参数；验证四能力目录、鉴权、附件、幂等、通知回传和故障变灰。 */
  async run_tests() {
    const require = createRequire(import.meta.url)
    const relay = process.env.SYNLOVE_TEST_RELAY_ROOT || resolve(this.agent, '../../消息中转')
    const { hubServer } = require(join(relay, 'dist/hub/hubServer.js'))
    const { load_hub_config } = require(join(relay, 'dist/common/configLoader.js'))
    const { logger } = require(join(relay, 'dist/common/logger.js'))
    const { nodeAgent } = require(join(this.backend, 'relayNode/dist/nodes/nodeAgent.js'))
    const { build_runner_from_config } = require(join(this.backend, 'relayNode/dist/nodes/localClients.js'))
    const root = join(this.temp, 'businessRuntime')
    cpSync(join(this.backend, 'businessRuntime'), root, { recursive: true,
      filter: file => !file.includes('__pycache__') && !file.includes(join('businessRuntime', 'runtime')) &&
        !file.endsWith('serviceConfig.json') && !file.endsWith('newsDigest.json') && !file.endsWith('videoDigest.json') })
    const names = { scheduler: 'reminders', crawlerCenter: 'digest', webCollection: 'crawler', video: 'video' }
    const services = {}
    this.modelStub = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.statusCode = 200
        if (req.url === '/test-rss') {
          res.setHeader('Content-Type', 'application/xml')
          return res.end('<rss><channel><item><title>隔离新闻测试</title><link>https://example.invalid/news/1</link><pubDate>2026-11-02</pubDate></item></channel></rss>')
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'fake-gemma' }] } :
          req.url === '/healthz' ? { ok: true } :
          { choices: [{ message: { content: '隔离新闻摘要：这是一条测试新闻。' } }] }))
      })
    })
    await new Promise(done => this.modelStub.listen(0, '127.0.0.1', done))
    const stubBase = `http://127.0.0.1:${this.modelStub.address().port}`
    for (const name of Object.values(names)) {
      const port = await this.free_port()
      services[name] = { baseURL: `http://127.0.0.1:${port}/v1`, management: 'managed',
        apiKeyEnv: 'SYNLOVE_TEST_BUSINESS_KEY', timeoutSeconds: 30, background: false }
    }
    services.llm = { baseURL: stubBase + '/v1', management: 'external', model: 'fake-gemma', timeoutSeconds: 10 }
    services.rsshub = { baseURL: stubBase, management: 'external', timeoutSeconds: 10 }
    mkdirSync(join(root, 'newsDigest/config'), { recursive: true })
    writeFileSync(join(root, 'newsDigest/config/newsDigest.json'), JSON.stringify({
      sources: [{ name: '测试RSS', type: 'rsshub', path: '/test-rss', limit: 10 }],
      interest: '隔离测试', hot: { enabled: false }, push: { enabled: true },
    }))
    const cfgFile = join(root, 'config/serviceConfig.json')
    writeFileSync(cfgFile, JSON.stringify({ version: 1, services }))
    const env = { ...process.env, SYNLOVE_SERVICE_CONFIG: cfgFile,
      SYNLOVE_TEST_BUSINESS_KEY: this.token, PYTHONUTF8: '1' }
    for (const name of Object.values(names)) {
      const child = spawn(this.python, ['microServices/ServiceHost.py', name, '--config', cfgFile],
        { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', data => { this.lastError = String(data) })
      this.children.push(child)
      await this.wait_until(async () => {
        if (child.exitCode !== null) throw Error(this.lastError)
        return (await fetch(services[name].baseURL + '/health',
          { headers: { Authorization: 'Bearer ' + this.token } })).ok
      })
    }
    const log = new logger('isolated-business', { level: 'error' })
    this.hub = new hubServer({ ...load_hub_config(null), host: '127.0.0.1', token: this.token,
      taskTimeoutSeconds: 20, maxAttempts: 1, logFile: '' }, log)
    const { port } = await this.hub.start(0)
    const baseURL = `http://127.0.0.1:${port}/v1`
    process.env.SYNLOVE_TEST_BUSINESS_KEY = this.token
    const nodeCfg = { nodeId: 'isolated-business', name: 'isolated', token: this.token,
      hubUrl: `ws://127.0.0.1:${port}/ws/node`, heartbeatSeconds: 1,
      reconnectMinMs: 100, reconnectMaxMs: 300, logFile: '',
      capabilities: Object.keys(names).map(name => ({ name, priority: 1, concurrency: 8 })),
      workers: Object.fromEntries(Object.entries(names).map(([cap, name]) => [cap,
        { mode: 'synlove-business', baseUrl: services[name].baseURL.replace('/v1', ''),
          apiKeyEnv: 'SYNLOVE_TEST_BUSINESS_KEY', timeoutMs: 5000 }])) }
    this.node = new nodeAgent(nodeCfg, build_runner_from_config(nodeCfg, log).runner, log)
    this.node.start()
    await this.wait_until(async () => (await (await fetch(baseURL + '/capabilities',
      { headers: { Authorization: 'Bearer ' + this.token } })).json()).capabilities.length === 4)
    const config = { baseURL, transport: 'relay', relayCapability: 'scheduler',
      management: 'external', timeoutSeconds: 30, apiKeyEnv: 'SYNLOVE_TEST_BUSINESS_KEY' }
    const probe = new ServiceProbe()
    assert.equal((await probe.probe_service('reminders', config)).available, true)
    assert.equal((await probe.probe_service('reminders', config)).location, 'remote')
    const remoteCfg = join(this.temp, 'client.json')
    writeFileSync(remoteCfg, JSON.stringify(config))
    const script = [
      'import json,sys,concurrent.futures',
      'from pathlib import Path',
      'from microServices.ServiceTransport import ServiceTransport',
      'cfg=json.loads(Path(sys.argv[1]).read_text())',
      't=ServiceTransport(cfg)',
      'm={"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"remind_add","arguments":{"text":"隔离测试提醒","inSeconds":60}}}',
      'r=t.call(m,request_id="same_request"); assert not r["result"].get("isError"),r',
      'r=t.call(m,request_id="same_request"); assert not r["result"].get("isError"),r',
      's=json.loads(t.request("GET","/snapshot")); assert s["total"]==1,s',
      'p=Path(sys.argv[1]).with_suffix(".txt");p.write_bytes(b"isolated upload test")',
      'key=t.upload(p); assert t.download(key)==p.read_bytes()',
      'm["params"]["arguments"]["text"]="different"; failed=False',
      'try:t.call(m,request_id="same_request")',
      'except RuntimeError:failed=True',
      'assert failed,"same ID different input accepted"',
      'print(json.dumps({"idempotent":True,"upload":True,"download":True,"conflictRejected":True}))',
    ].join('\n')
    const result = await this.run_command(this.python, ['-c', script, remoteCfg], this.agent)
    assert.equal(JSON.parse(result.trim()).upload, true)
    const newsConfig = join(this.temp, 'newsClient.json')
    writeFileSync(newsConfig, JSON.stringify({ ...config, relayCapability: 'crawlerCenter' }))
    const newsScript = 'import json,sys;from pathlib import Path;from microServices.ServiceTransport import ServiceTransport;' +
      't=ServiceTransport(json.loads(Path(sys.argv[1]).read_text()));' +
      'm={"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"digest_run","arguments":{}}};' +
      'a=t.call(m,request_id="news-one");assert not a["result"].get("isError"),a;' +
      'b=t.call(m,request_id="news-two");assert not b["result"].get("isError"),b;' +
      'print("news-pipeline-pass")'
    assert((await this.run_command(this.python, ['-c', newsScript, newsConfig], this.agent)).includes('news-pipeline-pass'))
    assert.equal((await probe.probe_service('digest', { ...config, relayCapability: 'crawlerCenter' })).available, true)
    // 生成一条真正落库的后台通知，经Hub拉回本机，随后进入既有QQ队列（发送函数用假实现）。
    await this.run_command(this.python, ['-c',
      'from pathlib import Path;from microServices.NotificationStore import NotificationStore;' +
      'NotificationStore(Path("runtime/notifications.sqlite")).enqueue("隔离后台完成结果","test-job-1")'], root)
    const local = join(this.temp, 'personal')
    mkdirSync(join(local, 'newsDigest/config'), { recursive: true })
    writeFileSync(join(local, 'newsDigest/config/newsDigest.json'),
      JSON.stringify({ push: { userOpenid: 'isolated-user' } }))
    const fullConfig = join(this.temp, 'fullClient.json')
    writeFileSync(fullConfig, JSON.stringify({ version: 1, services: {
      reminders: config, digest: { ...config, relayCapability: 'crawlerCenter' },
    } }))
    const home = join(local, 'runtime/dsh')
    const pullScript = 'from pathlib import Path;from microServices.NotificationPuller import NotificationPuller;' +
      'import json,sys;print(json.dumps(NotificationPuller(Path(sys.argv[1])).pull_results()))'
    const pulled = JSON.parse((await this.run_command(this.python, ['-c', pullScript, local], this.agent,
      { SYNLOVE_SERVICE_CONFIG: fullConfig, DSH_HOME: home })).trim())
    assert.equal(pulled.accepted, 2)
    const inbox = join(home, 'backendNotifications')
    const name = readdirSync(inbox).find(name => name.endsWith('.json'))
    const notice = readFileSync(join(inbox, name))
    const { BackendNotifications } = await import('../backend/packages/webhook/webhook-qq/lib/types/BackendNotifications.js')
    const { QqOutbox } = await import('../backend/packages/webhook/webhook-qq/lib/types/QqOutbox.js')
    let sent = 0
    const queueFile = join(home, 'isolated-qq-outbox.json')
    const sender = async () => { sent++; return { ok: true, mode: 'active' } }
    const queue = new QqOutbox(queueFile, sender, () => {})
    await new BackendNotifications(home, row => queue.enqueue_reply(row)).receive_results()
    await queue.drain_queue()
    assert.equal(sent, 2)
    // 模拟本机收到确认前重启并再次收到相同结果；持久收据必须防止二次发送。
    writeFileSync(join(inbox, name), notice)
    const restored = new QqOutbox(queueFile, sender, () => {})
    await new BackendNotifications(home, row => restored.enqueue_reply(row)).receive_results()
    await restored.drain_queue()
    assert.equal(sent, 2)
    assert.equal(JSON.parse((await this.run_command(this.python, ['-c', pullScript, local], this.agent,
      { SYNLOVE_SERVICE_CONFIG: fullConfig, DSH_HOME: home })).trim()).accepted, 0)
    const read = new BusinessEndpoint(config, fetch, this.token)
    const snapshots = await Promise.all(Array.from({ length: 16 }, () => read.read_status('/snapshot')))
    assert(snapshots.every(row => row.total === 1))
    const healthBad = await probe.probe_service('video', { ...config, relayCapability: 'video' })
    assert.equal(healthBad.available, false)
    const unsafe = await fetch(baseURL + '/tasks', { method: 'POST',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: 'scheduler', input: { method: 'POST', path: '/v1/shutdown' } }) })
    const task = await unsafe.json()
    await this.wait_until(async () => {
      const view = await (await fetch(baseURL + '/tasks/' + task.id,
        { headers: { Authorization: 'Bearer ' + this.token } })).json()
      return view.status === 'failed'
    })
    this.node.simulate_drop()
    await this.wait_until(() => this.node.connected())
    assert.equal((await read.read_status('/health')).ok, true)
    this.children[0].kill()
    await this.wait_until(() => this.children[0].exitCode !== null || this.children[0].signalCode !== null)
    assert.equal((await probe.probe_service('reminders', config)).available, false)
    console.log(JSON.stringify({ passed: true, checks: [
      '四能力注册与工具服务启动', '远端真实健康与远程灯色', '相同请求仅一个提醒', '冲突ID拒绝',
      'Python经Hub上传和下载字节一致', '16并发快照', '依赖缺失灰灯',
      '拒绝远程关闭接口', '出站节点断线重连', '上游死亡灰灯',
      '远端通知实际落库并拉取确认', '本机QQ队列接收与重启收据去重',
      'RSS采集与Gemma摘要及通知流水线（假模型）', '新闻二次采集不重复通知'], temp: this.temp }))
  }

  /** 无参数；只关闭当前测试持有的节点、Hub与子进程，不接触生产端口。 */
  async close_resources() {
    this.node?.stop()
    for (const child of this.children) child.kill()
    await this.hub?.stop()
    if (this.modelStub) await new Promise(done => this.modelStub.close(done))
  }
}

const test = new BusinessRelayTests()
try { await test.run_tests() }
finally { await test.close_resources() }
