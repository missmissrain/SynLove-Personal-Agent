/**
 * Harness Session 持久化微服务。
 *
 * 负责：在服务端持有唯一 JsonlSessionPersistence，向本地或远程 Harness 暴露
 * create/open/read/append/flush/stat/list/close API。
 * 参数：SYNLOVE_SESSION_ROOT、SYNLOVE_SESSION_COMPRESSION、SYNLOVE_SESSION_API_KEY、
 * SYNLOVE_SESSION_PORT。服务不运行 Agent、不调用模型、不解释 session 事件。
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../vendor/cordis/lib/index.js'
import JsonlSessionPersistence from '../packages/session/session-persistence-jsonl/lib/index.js'

const root = process.env.SYNLOVE_SESSION_ROOT
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const compression = process.env.SYNLOVE_SESSION_COMPRESSION ?? 'zstd'
const apiKey = process.env.SYNLOVE_SESSION_API_KEY ?? ''
const port = Number(process.env.SYNLOVE_SESSION_PORT ?? '8801')
const host = process.env.SYNLOVE_SESSION_HOST ?? '127.0.0.1'
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !apiKey) {
  throw new Error('非回环 Session API 必须配置独立密钥')
}
const handles = new Map()
// 服务端是持久化权威，不能继承客户端 remote 模式再把请求递归发回自身。
process.env.SYNLOVE_SESSION_MODE = 'local'
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, compression })
const persistence = ctx.sessionPersistence

const tools = [
  'session_create', 'session_open', 'session_read', 'session_append',
  'session_flush', 'session_flush_all', 'session_stat', 'session_list', 'session_close',
]

function json(value) {
  return JSON.stringify(value)
}

function handleData(handle) {
  return {
    handleId: handle.id + ':' + randomUUID(),
    sessionId: String(handle.id),
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    access: handle.access,
  }
}

function requireHandle(id) {
  const handle = handles.get(String(id))
  if (!handle) throw new Error('session handle 不存在或服务已重启')
  return handle
}

async function call(name, args) {
  if (name === 'session_create') {
    const handle = await persistence.create(args.header, {
      ...(args.inheritedEventCount === undefined ? {} : { inheritedEventCount: args.inheritedEventCount }),
    })
    const info = handleData(handle)
    handles.set(info.handleId, handle)
    return info
  }
  if (name === 'session_open') {
    const handle = await persistence.open(String(args.sessionId), args.access)
    const info = handleData(handle)
    handles.set(info.handleId, handle)
    return info
  }
  if (name === 'session_read') {
    const result = await requireHandle(args.handleId).read(args.offset, args.length)
    return { eventState: result.eventState, events: result.events }
  }
  if (name === 'session_append') {
    await requireHandle(args.handleId).append(args.events ?? [])
    return { ok: true }
  }
  if (name === 'session_flush') {
    await requireHandle(args.handleId).flush()
    return { ok: true }
  }
  if (name === 'session_flush_all') {
    await persistence.flush()
    return { ok: true }
  }
  if (name === 'session_stat') {
    return { snapshot: await persistence.stat(String(args.sessionId)) }
  }
  if (name === 'session_list') {
    return { snapshots: await persistence.list() }
  }
  if (name === 'session_close') {
    const handle = handles.get(String(args.handleId))
    if (handle) {
      await handle.close()
      handles.delete(String(args.handleId))
    }
    return { ok: true }
  }
  throw new Error(`未知 session 工具：${name}`)
}

async function dispatch(message) {
  if (message?.method === 'tools/list') return { tools: tools.map(name => ({ name })) }
  if (message?.method !== 'tools/call') throw new Error('只支持 tools/list 和 tools/call')
  const params = message.params ?? {}
  return { structuredContent: await call(String(params.name), params.arguments ?? {}) }
}

function send(response, status = 200) {
  const body = Buffer.from(json(response), 'utf8')
  return { status, body }
}

async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > 8 * 1024 * 1024) throw new Error('请求超过 8MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const server = createServer(async (request, response) => {
  try {
    // 浏览器网页不能直接操作本机存储或停服；服务间客户端不发送 Origin。
    if (request.headers.origin
      || request.method === 'POST' && !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      response.writeHead(403, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'cross-origin or invalid content type' }))
      return
    }
    if (apiKey && request.headers.authorization !== `Bearer ${apiKey}`) {
      const result = send({ error: 'unauthorized' }, 401)
      response.writeHead(result.status, { 'Content-Type': 'application/json' })
      response.end(result.body)
      return
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
      const result = send({ ok: true, service: 'session', protocol: 1, busy: false })
      response.writeHead(result.status, { 'Content-Type': 'application/json' })
      response.end(result.body)
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/tools') {
      const result = send({ tools: tools.map(name => ({ name })) })
      response.writeHead(result.status, { 'Content-Type': 'application/json' })
      response.end(result.body)
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/shutdown') {
      const result = send({ ok: true }, 202)
      response.writeHead(result.status, { 'Content-Type': 'application/json' })
      response.end(result.body)
      setImmediate(async () => {
        await persistence.flush()
        await ctx.fiber.dispose()
        server.close()
      })
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/rpc') throw new Error('未知 session API 路径')
    const envelope = await readBody(request)
    const rpc = await dispatch(envelope.message ?? envelope)
    const result = send({ state: 'done', requestId: envelope.requestId, result: { result: rpc } })
    response.writeHead(result.status, { 'Content-Type': 'application/json' })
    response.end(result.body)
  } catch (error) {
    const result = send({ state: 'done', result: { isError: true, content: [{ type: 'text', text: String(error) }] } }, 200)
    response.writeHead(result.status, { 'Content-Type': 'application/json' })
    response.end(result.body)
  }
})

server.listen(port, host)
