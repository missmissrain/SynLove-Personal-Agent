/**
 * 通用 MCP 求值器：把一个 JS 函数文件丢进页面执行，打印结果。
 *
 * 用途：调试采集规则（先看页面结构，再定 DOM 选择器），不必每次写新脚本。
 *
 * 参数：
 *   --url=<地址>      要打开的页面（必填）
 *   --js=<文件路径>   页面内执行的函数源码，形如 `() => ({...})`（必填）
 *   --headed          有界面运行（默认无头）
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CLI = join(HERE, 'node_modules', '@playwright', 'mcp', 'cli.js')
const NODE = process.env.DSH_NODE ?? 'node'

const arg = name => {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}
const url = arg('url')
const js_file = arg('js')
if (url === undefined || js_file === undefined) {
  console.error('用法: node evalOnce.mjs --url=<地址> --js=<函数文件>')
  process.exit(2)
}
const code = readFileSync(js_file, 'utf8').trim()

const child = spawn(NODE, [
  CLI,
  '--browser=msedge',
  '--headless',
  `--user-data-dir=${join(ROOT, 'runtime', 'browser-profile')}`,
  `--output-dir=${join(ROOT, 'runtime', 'browser-mcp-output')}`,
  '--viewport-size=1280x900',
  '--idle-timeout=60000',
], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })

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
    if (pending === undefined) continue
    waiting.delete(message.id)
    if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error).slice(0, 300)))
    else pending.resolve(message.result)
  }
})
const request = (method, params) => new Promise((resolve, reject) => {
  const id = next_id++
  waiting.set(id, { resolve, reject })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})

const text_of = result => (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-eval', version: '1.0.0' } })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  await request('tools/call', { name: 'browser_navigate', arguments: { url } })
  const result = await request('tools/call', { name: 'browser_evaluate', arguments: { function: code } })
  process.stdout.write(`${text_of(result)}\n`)
} catch (error) {
  console.error(`执行失败：${error.message}`)
  process.exitCode = 1
} finally {
  child.kill()
}
