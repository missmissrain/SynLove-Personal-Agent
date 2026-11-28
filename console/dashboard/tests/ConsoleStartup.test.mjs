/**
 * GUI启动协调回归：假控制台验证重复请求合并、失败报告与统一启动协议。
 * 默认不创建进程，不启动真实服务。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ConsoleStartup } = require('../../ConsoleStartup.js')

test('并发启动请求合并，后台只接受一次统一start指令', async () => {
  let count = 0
  const client = new ConsoleStartup({ url: 'http://127.0.0.1:1', fetcher: async (url, options) => {
    count++
    assert.equal(url, 'http://127.0.0.1:1/api/service')
    assert.deepEqual(JSON.parse(options.body), { action: 'start' })
    await new Promise(resolve => setImmediate(resolve))
    return new Response('{"ok":true}')
  } })
  assert.ok((await Promise.all(Array.from({ length: 20 }, () => client.request_start()))).every(Boolean))
  assert.equal(count, 1)
})

test('失败如实报告，随后显式启动可再次提交', async () => {
  let count = 0
  const logs = []
  const client = new ConsoleStartup({ url: 'http://127.0.0.1:1', log: message => logs.push(message),
    fetcher: async () => { count++; throw new Error('offline') } })
  assert.equal(await client.request_start(), false)
  assert.equal(await client.request_start(), false)
  assert.equal(count, 2)
  assert.ok(logs.every(message => message.includes('失败')))
})
