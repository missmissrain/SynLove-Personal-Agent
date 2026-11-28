/**
 * 本机按需可用性测试：临时模型文件和解释器桩验证前置条件、远程隔离及缓存。
 * 默认不启动音频服务、不加载权重、不下载模型、不调用付费接口。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { ServiceReadiness } from '../ServiceReadiness.mjs'

/** 参数 t：测试上下文；建立满足本机启动路径规则的临时资源。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synloveReadiness-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (name, content = 'fixture') => {
    const file = join(root, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    return file
  }
  for (const name of ['LocalServiceLifecycle.py', 'AudioHttp.py', 'breezeTtsService.py', 'whisperService.py']) put(`services/${name}`)
  const python = put('python.exe')
  put('repo/breeze_infer/runtime.py')
  put('repo/models/fast_streaming.py')
  for (const name of ['config.json', 'tokenizer.json', 'weights.safetensors']) put(`model/${name}`)
  put('model/model.safetensors.index.json', JSON.stringify({ weight_map: { test: 'weights.safetensors' } }))
  for (const name of ['config.json', 'tokenizer.json', 'model.bin']) put(`whisper/${name}`)
  const env = { BREEZE_PYTHON: python, BREEZE_REPO: join(root, 'repo'), BREEZE_CKPT: join(root, 'model'), WHISPER_PYTHON: python }
  const cfg = { baseURL: 'http://127.0.0.1:7862/v1', management: 'managed', model: join(root, 'whisper') }
  return { root, cfg, env, put }
}

test('本机 TTS/ASR 就绪条件通过，闲置时也可按需调用', async t => {
  const f = fixture(t)
  const ready = new ServiceReadiness({ project: f.root, env: f.env, checkPython: async () => true })
  assert.equal(await ready.assess('tts', f.cfg), true)
  assert.equal(await ready.assess('asr', f.cfg), true)
})

test('配置存在但模型缺片时不标可用', async t => {
  const f = fixture(t)
  unlinkSync(join(f.root, 'model', 'weights.safetensors'))
  const ready = new ServiceReadiness({ project: f.root, env: f.env, checkPython: async () => true })
  assert.equal(await ready.assess('tts', f.cfg), false)
})

test('Python 依赖不全时不标可用', async t => {
  const f = fixture(t)
  const ready = new ServiceReadiness({ project: f.root, env: f.env, checkPython: async () => false })
  assert.equal(await ready.assess('tts', f.cfg), false)
  assert.equal(await ready.assess('asr', f.cfg), false)
})

test('外部服务、远程托管地址和 LLM 不套用本机音频待机逻辑', async t => {
  const f = fixture(t)
  const ready = new ServiceReadiness({ project: f.root, env: f.env, checkPython: async () => { throw new Error('不应调用') } })
  assert.equal(await ready.assess('tts', { ...f.cfg, management: 'external' }), false)
  assert.equal(await ready.assess('tts', { ...f.cfg, baseURL: 'http://remote.example/v1' }), false)
  assert.equal(await ready.assess('llm', f.cfg), false)
})

test('并发与重复刷新复用依赖检查，配置变化重新判断', async t => {
  const f = fixture(t)
  let calls = 0
  const ready = new ServiceReadiness({ project: f.root, env: f.env, checkPython: async () => { calls++; return true } })
  const results = await Promise.all(Array.from({ length: 10 }, () => ready.assess('tts', f.cfg)))
  assert.ok(results.every(Boolean))
  assert.equal(calls, 1)
  assert.equal(await ready.assess('asr', { ...f.cfg, model: join(f.root, 'missing') }), false)
})
