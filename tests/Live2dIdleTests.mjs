/**
 * Live2D待机验收：核查独立眨眼、动作边界、减少动态与模型依赖文件完整性。
 * 参数为node --test tests/Live2dIdleTests.mjs；无需业务后端、网络或模型令牌。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Live2dIdleMotion } from '../console/public/Avatar/Live2dIdleMotion.js'
import { Live2dGestureLibrary } from '../console/public/Avatar/Live2dGestureLibrary.js'
import { Live2dHairMotion } from '../console/public/Avatar/Live2dHairMotion.js'

const presets = JSON.parse(readFileSync(new URL('../console/public/Avatar/config/IdleGestures.json', import.meta.url))).presets

test('八个待机动作起止归零并且不会连续重复最近两项', () => {
  const library = new Live2dGestureLibrary(presets, () => .4)
  assert.equal(presets.length, 8)
  for (const preset of presets) {
    library.start_action(0, preset.name)
    for (const value of Object.values(library.sample_action(0))) assert.ok(value === 0)
    const end = library.sample_action(preset.duration - .00001)
    for (const value of Object.values(end)) assert.ok(Math.abs(value) < .00001)
    assert.deepEqual(library.sample_action(preset.duration), {})
  }
  const history = []
  for (let i = 0; i < 40; i++) {
    library.start_action(i * 12)
    assert.ok(!history.slice(-2).includes(library.active.name))
    history.push(library.active.name)
  }
})

test('预载动作连续运行幅度受控，减少动态时取消小动作', () => {
  const idle = new Live2dIdleMotion(Math.random, presets)
  for (let i = 0; i < 12000; i++) {
    const pose = idle.sample_pose(1 / 60)
    assert.ok(Math.abs(pose.ParamArmR) <= .81)
    assert.ok(Math.abs(pose.ParamAngleX) <= 19.6)
    assert.ok(Math.abs(pose.ParamAngleZ) <= 13.6)
    assert.ok(Math.abs(pose.ParamHairFront) <= .9)
    assert.equal(pose.ParamMouthOpenY, 0)
    for (const value of Object.values(pose)) assert.ok(Number.isFinite(value))
  }
  idle.sample_pose(1 / 30, true)
  assert.equal(idle.gestures.active, null)
  const clock = idle.time
  idle.sample_pose(.4)
  assert.ok(idle.time - clock > .39, '低帧率时仍须按照真实时间推进待机')
})

test('两分钟待机包含眨眼且保持自然垂臂、嘴巴闭合', () => {
  const idle = new Live2dIdleMotion(() => .5)
  let blinks = 0, closed = false
  for (let i = 0; i < 7200; i++) {
    const pose = idle.sample_pose(1 / 60)
    for (const v of Object.values(pose)) assert.ok(Number.isFinite(v))
    assert.equal(pose.ParamEyeLOpen, pose.ParamEyeROpen)
    assert.equal(pose.ParamMouthOpenY, 0)
    assert.ok(Math.abs(pose.ParamArmL) <= .18)
    assert.ok(Math.abs(pose.ParamArmR) <= .18)
    assert.ok(Math.abs(pose.ParamAngleX) <= 5.5)
    if (pose.ParamEyeLOpen < .1 && !closed) blinks++
    closed = pose.ParamEyeLOpen < .1
  }
  assert.ok(blinks >= 20 && blinks <= 30)
})

test('指针跟随平滑且减少动态时停止肢体摆动', () => {
  const idle = new Live2dIdleMotion()
  idle.set_pointer(100, -100)
  const pose = idle.sample_pose(1 / 30)
  assert.ok(pose.ParamEyeBallX > 0 && pose.ParamEyeBallX < .15)
  for (let i = 0; i < 120; i++) {
    const quiet = idle.sample_pose(1 / 30, true)
    assert.ok(quiet.ParamArmL === 0)
    assert.ok(quiet.ParamAngleX === 0)
    assert.ok(quiet.ParamBreath === 0)
    assert.equal(quiet.ParamHairFront, 0)
  }
  idle.set_pointer(null, null)
  assert.deepEqual(idle.pointer, [0, 0])
})

test('刘海独立摆动，有转头惯性，低帧率下仍稳定且不瞬间跳变', () => {
  const still = new Live2dHairMotion(), turning = new Live2dHairMotion()
  let low = Infinity, high = -Infinity
  for (let i = 0; i < 240; i++) {
    const value = still.sample_motion(1 / 24, 0, 0)
    low = Math.min(low, value)
    high = Math.max(high, value)
  }
  assert.ok(high - low > .8, '静止头部时刘海仍有独立的微风摆动')
  const base = new Live2dHairMotion()
  base.sample_motion(1 / 24, 0, 0)
  turning.sample_motion(1 / 24, 0, 0)
  const moving = turning.sample_motion(1 / 24, 12, 8)
  const steady = base.sample_motion(1 / 24, 0, 0)
  assert.ok(moving < steady, '转头产生相反方向的惯性')
  let last = moving
  for (let i = 0; i < 120; i++) {
    const next = turning.sample_motion(.5, Math.sin(i) * 25, Math.cos(i) * 15)
    assert.ok(Number.isFinite(next) && Math.abs(next) <= .9)
    assert.ok(Math.abs(next - last) < 1.2)
    last = next
  }
  assert.equal(turning.sample_motion(1 / 24, 0, 0, true), 0)
})

test('模型全部纹理、物理与四组动作均随发行文件提供', () => {
  const dir = new URL('../console/public/Avatar/live2d/', import.meta.url)
  const model = JSON.parse(readFileSync(new URL('XinAi.model3.json', dir)))
  const ref = model.FileReferences
  const files = [ref.Moc, ref.Physics, ref.DisplayInfo, ...ref.Textures,
    ...Object.values(ref.Motions).flat().map(m => m.File), 'StandingFallback.png']
  for (const file of files) assert.ok(existsSync(new URL(file, dir)), file)
  const info = JSON.parse(readFileSync(new URL(ref.DisplayInfo, dir)))
  assert.ok(info.Parameters.some(row => row.Id === 'ParamHairFront'), '发行模型必须包含独立刘海轴')
  assert.deepEqual(Object.keys(ref.Motions).sort(), ['Fingers', 'Idle', 'Legs', 'Wave'])
})
