/**
 * 思考强度回归：使用真实Harness与假模型验证即时设置、主子隔离、结果润色及不支持档位回退。
 * 无运行参数；临时目录存放测试配置，不读取生产密钥、不访问网络、不调用真实模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { AgentReasoningStore } from '../console/AgentReasoningStore.mjs'
import { AgentReasoning } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/AgentReasoning.js'
import { TaskRuntime } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskRuntime.js'
const require = createRequire(join(process.cwd(), 'backend/package.json'))
const { Context } = require('@deepseek-ai/cordis')
const { LlmAdapter, createUserMessage } = require('@deepseek-ai/dsh-llm')

/** 无参数；创建独立工程，提示词使用公开测试输入，不复制生产配置。 */
function make_root() {
  const root = mkdtempSync(join(tmpdir(), 'synlove-reasoning-'))
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, 'prompts'))
  for (const name of ['PresenterProtocol.md', 'WorkerProtocol.md', 'TaskExecution.md'])
    copyFileSync(join(process.cwd(), 'prompts', name), join(root, 'prompts', name))
  return root
}

/** seen记录真实请求，levels提供当前假模型能力；全部模型推理使用固定返回。 */
async function make_context(seen, levels = ['low', 'medium', 'high']) {
  const ctx = new Context()
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'llm', 'agent-loop', 'mcp-resources'])
    await ctx.plugin(require('@deepseek-ai/dsh-' + name).default,
      name === 'system-prompt' ? { personaPrefix: '测试欣爱', includeRuntimeContext: false } :
      name === 'agent-loop' ? { agents: [] } : name === 'tools' ? { mode: 'native' } : undefined)
  class FixtureAdapter extends LlmAdapter {
    /** provider/model为假路由，显式给出推理能力，覆盖真实内核的能力校验。 */
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, ...(levels.length ? {
        reasoning: { efforts: levels.map(id => ({ id, name: id })), defaultEffort: levels[0] },
      } : {}) }
    }
    /** options为内核最终参数，记录实际强度后返回固定文本。 */
    async *stream(options) {
      seen.push({ id: String(options.sessionId), effort: options.reasoningEffort, model: options.model })
      yield { type: 'text-delta', index: 0, text: '测试完成。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter())
  ctx.provide('agentPresets', { resolve: async () => ({ id: 'task-worker' }), mount: async () => {} })
  return ctx
}

/** agent为真实会话；注入一条固定输入并检查确实收到模型返回，而不是只等待空闲。 */
async function run_turn(agent, seen) {
  const before = seen.length
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '测试' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(seen.length, before + 1)
  return seen.at(-1)
}

test('GUI两项默认low，独立原子保存并拒绝非法角色和档位', () => {
  const root = make_root()
  try {
    const store = new AgentReasoningStore(root)
    assert.deepEqual(store.read_config(), { presenter: 'low', worker: 'low' })
    assert.equal(store.list_controls().length, 2)
    store.save_setting('worker', 'high')
    store.save_setting('presenter', 'medium')
    assert.deepEqual(store.read_config(), { presenter: 'medium', worker: 'high' })
    assert.throws(() => store.save_setting('../secrets', 'high'))
    assert.throws(() => store.save_setting('worker', 'unlimited'))
    assert.deepEqual(store.read_config(), { presenter: 'medium', worker: 'high' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('既有主子会话下一次实际模型调用更新，子任务不继承主强度，润色使用主强度', async () => {
  const root = make_root(), seen = [], ctx = await make_context(seen)
  const runtime = new TaskRuntime(ctx, root, { workerPreset: 'task-worker', workerModel: { reasoningEffort: 'high' } })
  const handles = []
  try {
    const main = await ctx.agents.create({ sessionId: 'reasoning-main', agentOptions: { provider: 'fixture', model: 'fixture' } })
    handles.push(main)
    await runtime.attach_presenter(main.agent, {})
    const worker = await runtime.factory.create_worker({ worker: 'task-reasoning', origin: { workspace: root } },
      { provider: 'fixture', model: 'fixture', reasoningEffort: 'high' })
    handles.push(worker)
    assert.equal((await run_turn(main.agent, seen)).effort, 'low')
    assert.equal((await run_turn(worker.agent, seen)).effort, 'low')
    const store = new AgentReasoningStore(root)
    store.save_setting('presenter', 'high')
    store.save_setting('worker', 'medium')
    assert.equal((await run_turn(main.agent, seen)).effort, 'high')
    assert.equal((await run_turn(worker.agent, seen)).effort, 'medium')
    const count = seen.length
    const notice = await runtime.bridge.present_result(main.agent, {
      id: 'reasoning-notice', session: 'reasoning-main', state: 'succeeded', result: '隔离检查通过。',
      origin: { options: { provider: 'fixture', model: 'fixture', reasoningEffort: 'medium' } },
    })
    assert.equal(notice, '测试完成。')
    assert.equal(seen.length, count + 1)
    assert.equal(seen.at(-1).effort, 'high')
  } finally {
    for (const handle of handles.reverse()) await handle.dispose()
    await runtime.close_runtime()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

for (const levels of [[], ['medium']]) {
  test(`模型能力${levels.join(',') || '无推理'}时不传不支持的档位，保留同一模型`, async () => {
    const root = make_root(), seen = [], ctx = await make_context(seen, levels)
    let handle
    try {
      handle = await ctx.agents.create({ sessionId: 'fallback', agentOptions: { provider: 'fixture', model: 'same-model', reasoningEffort: 'high' } })
      new AgentReasoning(root, 'presenter').attach_agent(handle.agent)
      const request = await run_turn(handle.agent, seen)
      assert.equal(request.effort, levels[0])
      assert.equal(request.model, 'same-model')
    } finally {
      await handle?.dispose()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('损坏配置不会阻止聊天，运行端回退low，GUI拒绝覆盖损坏文件', async () => {
  const root = make_root(), seen = [], ctx = await make_context(seen)
  let handle
  try {
    const path = join(root, 'config', 'agentReasoning.json')
    writeFileSync(path, '{invalid', 'utf8')
    assert.throws(() => new AgentReasoningStore(root).save_setting('worker', 'high'))
    assert.equal(readFileSync(path, 'utf8'), '{invalid')
    handle = await ctx.agents.create({ sessionId: 'invalid-config', agentOptions: { provider: 'fixture', model: 'fixture' } })
    new AgentReasoning(root, 'presenter').attach_agent(handle.agent)
    assert.equal((await run_turn(handle.agent, seen)).effort, 'low')
  } finally {
    await handle?.dispose()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
