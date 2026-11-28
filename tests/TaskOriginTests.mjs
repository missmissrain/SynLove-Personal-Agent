/**
 * 任务来源离线回归：直接执行源码和运行文件中的来源校验方法，无第三方依赖。
 * 参数：node --test tests/TaskOriginTests.mjs；使用内存来源库，不访问消息平台。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

/** path 为源码或运行文件路径；提取实际方法，避免加载调度器的外部依赖。 */
function load_method(path) {
  let code = readFileSync(new URL(path, import.meta.url), 'utf8')
  if (path.endsWith('.ts')) code = stripTypeScriptTypes(code, { mode: 'transform' })
  const start = code.indexOf('    current_origin(')
  const end = code.indexOf('    async call_tool(', start)
  assert.ok(start >= 0 && end > start)
  return runInNewContext(`({${code.slice(start, end)}}).current_origin`)
}

/** sources 为本轮消息来源；仅登记两个可信键，未知键与其他会话均不返回记录。 */
function make_fixture(sources) {
  const events = [{ type: 'turn/start' }, ...sources.map(source => ({
    type: 'user/message', data: { source },
  }))]
  const runtime = { store: { get_origin: (key, session) =>
    session === 'fixture' && ['qq:one', 'weixin:one'].includes(key)
      ? { channel: key.split(':')[0], owner: 'fixture', target: key } : undefined } }
  return { runtime, owner: { session: 'fixture', agent: { session: { snapshotEvents: () => events } } } }
}

for (const path of [
  '../backend/packages/webhook/webhook-weixin/src/agentTasks/TaskRuntime.ts',
  '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskRuntime.js',
]) {
  const method = load_method(path)
  test(`${path}: 实际QQ和微信插件消息保留可信来源`, () => {
    for (const [plugin, key] of [['webhook-qq', 'qq:one'], ['dsh-webhook-weixin', 'weixin:one']]) {
      const f = make_fixture([{ kind: 'plugin', plugin, form: 'notice', taskOriginId: key }])
      assert.equal(method.call(f.runtime, f.owner).key, key)
    }
  })
  test(`${path}: 通知不遮挡来源，双通道提交仍须指定来源`, () => {
    const f = make_fixture([
      { kind: 'plugin', plugin: 'webhook-qq', taskOriginId: 'qq:one' },
      { kind: 'plugin', plugin: 'dsh-webhook-weixin', taskOriginId: 'weixin:one' },
      { kind: 'plugin', plugin: 'time-context', form: 'snapshot' },
      { kind: 'plugin', plugin: 'model-switch', form: 'notice' },
    ])
    assert.throws(() => method.call(f.runtime, f.owner, undefined, true), /多个消息来源/)
    assert.equal(method.call(f.runtime, f.owner, 'qq:one', true).channel, 'qq')
    assert.throws(() => method.call(f.runtime, f.owner, 'forged', true), /不属于本轮/)
  })
  test(`${path}: QQ无可信键、失效键和结果回调均不能授权`, () => {
    for (const [source, pattern] of [
      [{ kind: 'plugin', plugin: 'webhook-qq' }, /没有可信通道来源/],
      [{ kind: 'plugin', plugin: 'webhook-qq', taskOriginId: 'qq:expired' }, /来源已失效/],
      [{ kind: 'synlove-task-result', taskOriginId: 'qq:one' }, /结果处理轮次/],
    ]) {
      const f = make_fixture([source])
      assert.throws(() => method.call(f.runtime, f.owner), pattern)
    }
    const f = make_fixture([{ kind: 'plugin', plugin: 'webhook-qq', taskOriginId: 'qq:one' }])
    f.owner.session = 'other'
    assert.throws(() => method.call(f.runtime, f.owner), /来源已失效/)
  })
}
