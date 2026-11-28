/**
 * 主动研究回归：冷启动、无候选、无需要、规划超时、跳过、成功、预算与重启恢复。
 * 只使用临时目录和假模型，不联网、不启动实例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {ProactiveStore} from '../backend/packages/webhook/webhook-weixin/lib/types/proactive/ProactiveStore.js'
import {ProactiveResearcher} from '../backend/packages/webhook/webhook-weixin/lib/types/proactive/ProactiveResearcher.js'
import {NotebookStore} from '../backend/packages/webhook/webhook-weixin/lib/types/notebook/NotebookStore.js'
import {ProfileInferenceStore} from '../backend/packages/webhook/webhook-weixin/lib/types/profile/ProfileInference.js'

const HOUR = 3_600_000
// 提示词从仓库里取，不依赖某台机器的绝对路径；文件缺失时实现会退回内置说明。
const PROMPTS = fileURLToPath(new URL('../prompts/', import.meta.url))

function local_day(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function make_env(initial_notes) {
  const dir = mkdtempSync(join(tmpdir(), 'synlove-proactive-'))
  let notes = initial_notes
  const graph = {
    async find(name) { return name === '主人' ? { id: 'p2', notes } : undefined },
    async upsert_person(input) { notes = input.notes; return {} },
  }
  const store = new ProactiveStore(join(dir, 'proactive'))
  const notebook = new NotebookStore(join(dir, 'notebook'))
  const profile = new ProfileInferenceStore(graph)
  let plan_mode = 'ok'
  let search_calls = 0
  const researcher = new ProactiveResearcher({
    store,
    notebook,
    profile,
    web: {
      async search() {
        search_calls += 1
        return { content: '伊斯坦布尔往返含税 4200 元', sources: [{ url: 'https://example.com', title: '示例' }] }
      },
    },
    complete: async (prompt) => {
      // 摘要请求会带搜索正文，规划请求不会；按内容分流，避免依赖提示词文本。
      if (prompt.includes('【搜索正文】')) return '查到伊斯坦布尔往返含税四千二，时间在春节前后。'
      if (plan_mode === 'throw') throw Error('plan timeout')
      if (plan_mode === 'skip') return '无'
      return '伊斯坦布尔 往返 机票 含税价格\n春节去伊斯坦布尔机票多少钱'
    },
    plan_prompt_path: join(PROMPTS, 'InferenceResearch.md'),
    summary_prompt_path: join(PROMPTS, 'InferenceDigest.md'),
    max_per_day: 3,
    min_gap_ms: 48 * HOUR,
    max_gap_ms: 72 * HOUR,
  })
  return {
    dir, store, notebook, profile, researcher,
    get notes() { return notes },
    set_plan(mode) { plan_mode = mode },
    get search_calls() { return search_calls },
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

const TRAVEL = '兴趣：旅行；推断-旅行：可能想去土耳其/欧洲旅行（高，2026-11，未调研）'
const TALK = '推断-沟通：喜欢直接结论（高，2026-11，未调研）'

test('冷启动只排下一次检查，不消耗预算也不研究', async () => {
  const env = make_env(TRAVEL)
  try {
    const now = Date.now()
    await env.researcher.run_due(now, false)
    assert.ok(env.store.state().next_research_at > now)
    assert.equal(env.store.state().searches, 0)
    assert.equal(env.notebook.entries().length, 0)
  } finally { env.cleanup() }
})

test('连续三次无候选不会耗尽预算，且下次时间不再停在过去', async () => {
  const env = make_env(TALK)
  try {
    let now = Date.now()
    for (let i = 0; i < 3; i++) {
      env.store.set_state({ next_research_at: now - 1000 })
      await env.researcher.run_due(now, false)
      assert.ok(env.store.state().next_research_at > now)
      assert.equal(env.store.state().searches, 0)
      now += 1000
    }
    assert.equal(env.notebook.entries().length, 0)
  } finally { env.cleanup() }
})

test('记事簿结果还新鲜时不重复研究，也不扣预算', async () => {
  const env = make_env(TRAVEL)
  try {
    const now = Date.now()
    env.notebook.append({
      topic_id: 'inference-旅行', kind: 'inference', title: '推断：旅行',
      summary: '刚查过，机票四千二', sources: [], fresh_hours: 72, created_at: now,
    })
    env.store.set_state({ next_research_at: now - 1000 })
    await env.researcher.run_due(now, false)
    assert.equal(env.notebook.entries().length, 1)
    assert.equal(env.store.state().searches, 0)
    assert.ok(env.store.state().next_research_at > now)
  } finally { env.cleanup() }
})

test('规划模型临时超时只安排快速重试，不跳过七天', async () => {
  const env = make_env(TRAVEL)
  try {
    const now = Date.now()
    env.set_plan('throw')
    env.store.set_state({ next_research_at: now - 1000 })
    await env.researcher.run_due(now, false)
    const next = env.store.state().next_research_at
    assert.ok(next > now)
    assert.ok(next - now <= HOUR + 1000)
    assert.equal(env.store.skipped('旅行', now), false)
    assert.equal(env.store.state().searches, 0)
    assert.equal(env.notebook.entries().length, 0)
  } finally { env.cleanup() }
})

test('规划判断不适合研究时进入七天退避，不联网', async () => {
  const env = make_env(TRAVEL)
  try {
    const now = Date.now()
    env.set_plan('skip')
    env.store.set_state({ next_research_at: now - 1000 })
    await env.researcher.run_due(now, false)
    assert.equal(env.store.skipped('旅行', now), true)
    assert.equal(env.search_calls, 0)
    assert.equal(env.store.state().searches, 0)
    assert.ok(env.store.state().next_research_at > now)
  } finally { env.cleanup() }
})

test('研究成功写记事簿、回写已调研、扣一次预算并排 48-72 小时', async () => {
  const env = make_env(TRAVEL)
  try {
    const now = Date.now()
    env.store.set_state({ next_research_at: now - 1000 })
    await env.researcher.run_due(now, false)
    assert.equal(env.notebook.entries().length, 1)
    assert.equal(env.notebook.entries()[0].topic_id, 'inference-旅行')
    assert.match(env.notes, /推断-旅行：.*已调研/)
    assert.equal(env.store.state().searches, 1)
    const gap = env.store.state().next_research_at - now
    assert.ok(gap >= 48 * HOUR && gap <= 72 * HOUR + 1000)
  } finally { env.cleanup() }
})

test('重启后读取已有状态，不到期不重复研究', async () => {
  const env = make_env(TRAVEL)
  try {
    const now = Date.now()
    env.store.set_state({ next_research_at: now - 1000 })
    await env.researcher.run_due(now, false)
    const next = env.store.state().next_research_at
    const searches = env.store.state().searches
    const restarted = new ProactiveStore(join(env.dir, 'proactive'))
    assert.equal(restarted.state().next_research_at, next)
    const again = new ProactiveResearcher({
      store: restarted,
      notebook: env.notebook,
      profile: env.profile,
      web: { async search() { throw Error('不应联网') } },
      complete: async () => { throw Error('不应调用模型') },
      plan_prompt_path: join(PROMPTS, 'InferenceResearch.md'),
      summary_prompt_path: join(PROMPTS, 'InferenceDigest.md'),
      max_per_day: 3,
    })
    await again.run_due(now + 1000, false)
    assert.equal(restarted.state().next_research_at, next)
    assert.equal(restarted.state().searches, searches)
    assert.equal(env.notebook.entries().length, 1)
  } finally { env.cleanup() }
})

test('当天预算用完时排到次日，不再反复尝试', async () => {
  const env = make_env(TRAVEL)
  try {
    const now = Date.now()
    env.store.set_state({ next_research_at: now - 1000, day: local_day(now), searches: 3 })
    await env.researcher.run_due(now, false)
    assert.equal(env.notebook.entries().length, 0)
    assert.equal(env.store.state().searches, 3)
    assert.ok(env.store.state().next_research_at - now > 6 * HOUR)
  } finally { env.cleanup() }
})
