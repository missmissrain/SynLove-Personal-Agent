/**
 * 开屏时间测试：模拟时钟验证首次启动、一小时边界、重复事件和跨进程恢复。
 * 注册参数 node --test；默认只使用临时状态文件，不启动模型和消息服务。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { OpeningPlaybackState } = require('../OpeningPlaybackState.js')

test('首次打开播放，重复显示不新建请求，短暂收起不重播，满一小时重播', t => {
  const dir = mkdtempSync(join(tmpdir(), 'synloveOpening-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let now = 1700000000000
  const state = new OpeningPlaybackState({ file: join(dir, 'state.json'), now: () => now })
  assert.deepEqual(state.record_open(), { requestId: 1, play: true, source: '/assets/Opening.mp4' })
  now += 7200000
  assert.deepEqual(state.record_open(), { requestId: 1, play: true, source: '/assets/Opening.mp4' }, '持续打开两小时不应重播')
  state.record_inactive()
  now += 3599999
  assert.equal(state.record_open().play, false)
  state.record_inactive()
  now += 3600000
  assert.equal(state.record_open().play, true)
})

test('重复隐藏保留离开起点，完整重启即使不足一小时也播放下一段', t => {
  const dir = mkdtempSync(join(tmpdir(), 'synloveOpeningRestart-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let now = 1700000000000
  const options = { file: join(dir, 'state.json'), now: () => now }
  const old = new OpeningPlaybackState(options)
  old.record_open()
  old.record_inactive()
  now += 1800000
  old.record_inactive()
  const resumed = old.record_open()
  assert.equal(resumed.play, false, '同一进程恢复不足一小时不播放')
  old.record_inactive()
  now += 1800000
  old.record_inactive()
  now += 1800000
  assert.equal(old.record_open().source, '/assets/Opening2.mp4', '重复隐藏不重置一小时起点')
  old.record_inactive()
  now += 1
  const restarted = new OpeningPlaybackState(options).record_open()
  assert.equal(restarted.play, true, '退出一毫秒后完整启动仍播放')
  assert.equal(restarted.source, '/assets/Opening3.mp4')
})

test('三段依次轮换并跨重启恢复，短暂打开不跳过下一段', t => {
  const dir = mkdtempSync(join(tmpdir(), 'synloveOpeningRotation-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let now = 1700000000000
  const options = { file: join(dir, 'state.json'), now: () => now }
  let state = new OpeningPlaybackState(options)
  for (const source of ['/assets/Opening.mp4', '/assets/Opening2.mp4', '/assets/Opening3.mp4', '/assets/Opening.mp4']) {
    const decision = state.record_open()
    assert.equal(decision.play, true)
    assert.equal(decision.source, source)
    assert.equal(state.record_open(), decision, '重复打开不推进序号')
    state.record_inactive()
    now += 1000
    assert.equal(state.record_open().play, false, '同一进程短暂恢复不消耗轮换')
    state.record_inactive()
    now += 1
    state = new OpeningPlaybackState(options)
  }
})
