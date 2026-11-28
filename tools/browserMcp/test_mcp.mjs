/**
 * Playwright MCP 冒烟测试（不经过模型，直接走 MCP stdio 协议）。
 *
 * 该脚本负责：
 * 1. 用 node 拉起本地 @playwright/mcp（Edge 通道 + 无头 + 独立 profile）；
 * 2. 完成 initialize 握手，列出工具清单（数量 + schema 字节数，评估 token 成本）；
 * 3. 打开一个无需登录的新闻页，抓快照与结构化数据（浏览器内取 DOM，比快照省 token）；
 * 4. 输出耗时、体积与样例，供后续"采集 → Gemma 提炼 → 推送"使用。
 *
 * 参数（命令行，均可选）：
 *   --url=<页面地址>       默认中国新闻网滚动新闻
 *   --headed               有界面运行（默认无头）
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CLI = join(HERE, 'node_modules', '@playwright', 'mcp', 'cli.js')
const NODE = process.env.DSH_NODE ?? 'node'
const OUT_DIR = join(ROOT, 'runtime', 'browser-mcp-output')
const PROFILE_DIR = join(ROOT, 'runtime', 'browser-profile')

const url_arg = process.argv.find(item => item.startsWith('--url='))
const TARGET_URL = url_arg === undefined ? 'https://www.chinanews.com.cn/scroll-news/news1.html' : url_arg.slice(6)
const HEADED = process.argv.includes('--headed')

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(PROFILE_DIR, { recursive: true })

/** 启动 Playwright MCP 子进程（Edge 通道，不下载浏览器）。 */
function start_server() {
  const args = [
    CLI,
    '--browser=msedge',
    ...(HEADED ? [] : ['--headless']),
    `--user-data-dir=${PROFILE_DIR}`,
    `--output-dir=${OUT_DIR}`,
    '--viewport-size=1280x900',
    '--timeout-action=15000',
    '--timeout-navigation=45000',
  ]
  const child = spawn(NODE, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.on('data', chunk => process.stderr.write(`[mcp] ${chunk}`))
  return child
}

/** 极简 MCP stdio 客户端：按行收发 JSON-RPC。 */
function create_client(child) {
  let next_id = 1
  const waiting = new Map()
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const pending = waiting.get(message.id)
      if (pending !== undefined) {
        waiting.delete(message.id)
        if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error).slice(0, 400)))
        else pending.resolve(message.result)
      }
    }
  })
  /** 发请求并等结果。 */
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next_id++
    waiting.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  /** 发通知（不需要结果）。 */
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  return { request, notify }
}

/** 取工具返回里的文本内容（多段拼接）。 */
function text_of(result) {
  return (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
}

async function main() {
  const child = start_server()
  const client = create_client(child)
  const started = Date.now()
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-smoke', version: '1.0.0' },
  })
  client.notify('notifications/initialized', {})
  console.log(`握手完成 ${Date.now() - started}ms，服务端=${init.serverInfo?.name} ${init.serverInfo?.version}`)

  const tools = await client.request('tools/list', {})
  const names = (tools.tools ?? []).map(item => item.name)
  const schema_bytes = Buffer.byteLength(JSON.stringify(tools.tools ?? []), 'utf8')
  console.log(`工具数=${names.length}  schema=${schema_bytes} 字节(≈${Math.round(schema_bytes / 3.5)} token)`)
  console.log(`工具名: ${names.join(', ')}`)

  const nav_started = Date.now()
  const nav = await client.request('tools/call', { name: 'browser_navigate', arguments: { url: TARGET_URL } })
  console.log(`打开页面 ${Date.now() - nav_started}ms：${text_of(nav).slice(0, 200).replace(/\n/g, ' ')}`)

  const snap_started = Date.now()
  const snap = await client.request('tools/call', { name: 'browser_snapshot', arguments: {} })
  const snap_text = text_of(snap)
  console.log(`快照 ${Date.now() - snap_started}ms，${snap_text.length} 字符`)
  writeFileSync(join(OUT_DIR, 'snapshot.txt'), snap_text, 'utf8')

  if (names.includes('browser_evaluate')) {
    const eval_started = Date.now()
    const eval_result = await client.request('tools/call', {
      name: 'browser_evaluate',
      arguments: {
        function: `() => Array.from(document.querySelectorAll('a')).map(a => ({ text: (a.innerText || '').trim(), href: a.href })).filter(item => item.text.length >= 8).slice(0, 40)`,
      },
    })
    const eval_text = text_of(eval_result)
    console.log(`browser_evaluate ${Date.now() - eval_started}ms，${eval_text.length} 字符`)
    writeFileSync(join(OUT_DIR, 'evaluate.txt'), eval_text, 'utf8')
  } else {
    console.log('（该版本没有 browser_evaluate，后续采集改用 browser_find / 快照解析）')
  }

  const title = text_of(await client.request('tools/call', { name: 'browser_snapshot', arguments: {} })).split('\n')[0]
  console.log(`页面首行: ${title}`)

  child.kill()
  console.log('测试结束')
}

main().catch(error => {
  console.error(`测试失败：${error.message}`)
  process.exitCode = 1
})
