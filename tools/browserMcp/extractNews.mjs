/**
 * 从"中国新闻网·滚动新闻"页提取结构化新闻列表（不经过模型，纯 DOM 规则）。
 *
 * 为什么用 browser_evaluate 而不是整页快照：整页无障碍快照约 9k 字符，
 * 而结构化结果只有几十条 × 30 字 ≈ 1.5k 字符，给 Gemma 筛选时省 80% 以上 token。
 *
 * 输出：JSON 数组 [{ time, title, url }]，直接打印到 stdout（UTF-8）。
 *
 * 参数（均可选）：
 *   --limit=30        最多输出多少条（默认 30）
 *   --url=<地址>      默认中新网滚动新闻首页
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CLI = join(HERE, 'node_modules', '@playwright', 'mcp', 'cli.js')
const NODE = process.env.DSH_NODE ?? 'node'
const PROFILE_DIR = process.argv.find(item => item.startsWith('--profile=')) === undefined
  ? join(ROOT, 'runtime', 'browser-profile')
  : process.argv.find(item => item.startsWith('--profile=')).slice(10)
const OUT_DIR = process.argv.find(item => item.startsWith('--out=')) === undefined
  ? join(ROOT, 'runtime', 'browser-mcp-output')
  : process.argv.find(item => item.startsWith('--out=')).slice(6)
const SAVE_PATH = process.argv.find(item => item.startsWith('--save=')) === undefined
  ? join(ROOT, 'runtime', 'news-raw.json')
  : process.argv.find(item => item.startsWith('--save=')).slice(7)

const limit_arg = process.argv.find(item => item.startsWith('--limit='))
const LIMIT = limit_arg === undefined ? 30 : Number(limit_arg.slice(8))
const url_arg = process.argv.find(item => item.startsWith('--url='))
const TARGET = url_arg === undefined ? 'https://www.chinanews.com.cn/scroll-news/news1.html' : url_arg.slice(6)

/** 页面内执行的提取函数（DOM 规则针对中新网滚动页）。
 *
 * 注意两个坑：
 * 1. `li` 里第一个 `<a>` 是栏目标签（"图片/视频"），标题在 `.dd_bt a`；
 * 2. 用 textContent 而不是 innerText —— innerText 依赖布局，隐藏元素取不到。 */
const EXTRACT = `() => {
  const rows = Array.from(document.querySelectorAll('.content_list li')).map(li => {
    const link = li.querySelector('.dd_bt a');
    const time = li.querySelector('.dd_time')?.textContent?.trim() ?? '';
    return {
      time: time.replace(/\\s+/g, ' ').slice(0, 20),
      title: (link?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      url: link?.href ?? '',
    };
  }).filter(item => item.title.length >= 6 && item.url.includes('chinanews.com.cn'));
  return rows;
}`

/** 拉起 Playwright MCP 子进程。 */
function start_server() {
  const child = spawn(NODE, [
    CLI,
    '--browser=msedge',
    '--headless',
    `--user-data-dir=${PROFILE_DIR}`,
    `--output-dir=${OUT_DIR}`,
    '--viewport-size=1280x900',
    '--timeout-action=15000',
    '--timeout-navigation=45000',
    '--idle-timeout=60000',
  ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  return child
}

/** 极简 MCP 客户端（按行 JSON-RPC）。 */
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
      if (pending === undefined) continue
      waiting.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error).slice(0, 300)))
      else pending.resolve(message.result)
    }
  })
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      const id = next_id++
      waiting.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }),
    notify: (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

/** 从 MCP 工具结果里取文本。 */
function text_of(result) {
  return (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
}

async function main() {
  const child = start_server()
  const client = create_client(child)
  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-news', version: '1.0.0' },
    })
    client.notify('notifications/initialized', {})
    await client.request('tools/call', { name: 'browser_navigate', arguments: { url: TARGET } })
    const result = await client.request('tools/call', {
      name: 'browser_evaluate',
      arguments: { function: EXTRACT },
    })
    const text = text_of(result)
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start < 0 || end < 0) throw new Error(`提取结果里没有 JSON：${text.slice(0, 200)}`)
    const rows = JSON.parse(text.slice(start, end + 1))
    const seen = new Set()
    const unique = rows.filter(item => {
      if (seen.has(item.url)) return false
      seen.add(item.url)
      return true
    }).slice(0, LIMIT)
    // 自己落盘（不经 stdout 重定向，避免 Windows 控制台把 UTF-8 转成 GBK 变乱码）
    const out_path = SAVE_PATH
    writeFileSync(out_path, JSON.stringify(unique, null, 2), 'utf8')
    console.log(`提取完成：${unique.length} 条 → ${out_path}`)
  } finally {
    child.kill()
  }
}

main().catch(error => {
  console.error(`提取失败：${error.message}`)
  process.exitCode = 1
})
