/**
 * 人物动作回归：验证九动作的边界、随机去重、温和模式和真实骨架矩阵，不调用模型或业务接口。
 * 参数为node --test tests/AvatarActionTests.mjs；使用仓库已有Three库及人物清单，不写模型资源。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from '../console/public/Avatar/vendor/Three.js'
import { AvatarIdleActions } from '../console/public/Avatar/AvatarIdleActions.js'
import { AvatarMotionController } from '../console/public/Avatar/AvatarMotionController.js'

const manifest=JSON.parse(readFileSync(new URL('../console/public/Avatar/assets/Avatar.json',import.meta.url),'utf8'))
const fields=['nod','tilt','yaw','arm','elbow','wrist','armR','elbowR','wristR','chest','shoulder']

test('九种动作首尾归零，整个包络有限且旋转幅度受控',()=>{
  const actions=new AvatarIdleActions()
  assert.equal(actions.names.length,9)
  for(const name of actions.names) {
    actions.start_action(10,name)
    for(const time of [9,10,10+actions.duration,11+actions.duration]) {
      for(const field of fields) assert.ok(Math.abs(actions.sample_action(time)[field])<1e-12,`${name}.${field} 未回零`)
    }
    let moved=false
    for(let i=0;i<=100;i++) {
      const sample=actions.sample_action(10+actions.duration*i/100)
      for(const field of fields) {
        assert.ok(Number.isFinite(sample[field]))
        assert.ok(Math.abs(sample[field])<=.08,`${name}.${field} 幅度过大`)
        moved ||= Math.abs(sample[field])>.001
      }
    }
    assert.ok(moved,`${name} 没有实际偏移`)
  }
})

test('自动动作避开最近三项，温和模式不选择挥手动作',()=>{
  const actions=new AvatarIdleActions()
  const history=[]
  for(let i=0;i<120;i++) {
    actions.start_action(i*10,undefined,i>=60)
    assert.ok(!history.slice(-3).includes(actions.name))
    if(i>=60) assert.ok(actions.gentleNames.includes(actions.name))
    history.push(actions.name)
  }
})

test('九种动作均驱动真实骨架且矩阵有限，静止预览不推进时间',()=>{
  for(const name of new AvatarIdleActions().names) {
    const motion=new AvatarMotionController(THREE,manifest.skeleton)
    motion.nextGesture=Infinity
    motion.start_gesture(name)
    const initial=motion.data.slice()
    let changed=false
    for(let i=0;i<180;i++) {
      motion.update_motion(1/30)
      assert.ok(motion.data.every(Number.isFinite),`${name} 矩阵异常`)
      changed ||= motion.data.some((value,index)=>Math.abs(value-initial[index])>1e-5)
    }
    assert.ok(changed)
    const time=motion.time
    motion.update_motion(1/30,true)
    assert.equal(motion.time,time)
    assert.equal(motion.state.still,true)
    motion.dispose_motion()
  }
})

test('系统减少动效时仍会自动播放温和动作并维持低幅度',()=>{
  const motion=new AvatarMotionController(THREE,manifest.skeleton)
  motion.nextGesture=0
  for(let i=0;i<90;i++) motion.update_motion(1/30,false,true)
  assert.equal(motion.state.still,false)
  assert.equal(motion.state.gentle,true)
  assert.ok(motion.actions.gentleNames.includes(motion.state.action))
  assert.ok(motion.state.actionActive)
  assert.ok(Math.abs(motion.state.headYaw)<.03)
  assert.ok(motion.time>2)
  motion.dispose_motion()
})
