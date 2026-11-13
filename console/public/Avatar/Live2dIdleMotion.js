/**
 * 欣爱轻量待机控制器：提供呼吸、眨眼、微小重心变化、头发与手腕摆动及柔和视线。
 * 注册参数random默认Math.random；动作只用本地数学插值，嘴巴默认闭合，不调用业务模型。
 */
import { Live2dGestureLibrary } from './Live2dGestureLibrary.js'
import { Live2dHairMotion } from './Live2dHairMotion.js'

export class Live2dIdleMotion {
  /** 参数random为随机源、presets为预载小动作；默认眨眼间隔三点二至六秒。 */
  constructor(random = Math.random, presets = []) {
    this.random = random
    this.time = 0
    this.nextBlink = 3.2 + random() * 2.8
    this.blinkStart = -10
    this.pointer = [0, 0]
    this.focus = [0, 0]
    this.preview = null
    this.gestures = new Live2dGestureLibrary(presets, random)
    this.hair = new Live2dHairMotion()
  }

  /** 参数x、y为归一化指针位置，null表示离开；只记录柔和视线目标。 */
  set_pointer(x, y) {
    this.pointer = [x == null ? 0 : Math.max(-1, Math.min(1, x)),
      y == null ? 0 : Math.max(-1, Math.min(1, y))]
  }

  /** 参数dt为秒、reduced为减少动态开关；返回当前帧的受控Cubism参数。 */
  sample_pose(dt, reduced = false) {
    this.time += Math.min(Math.max(dt, 0), .5)
    const t = this.time
    const blend = 1 - Math.exp(-dt * 3)
    this.focus = this.focus.map((v, i) => v + (this.pointer[i] - v) * blend)
    if (t >= this.nextBlink) {
      this.blinkStart = t
      this.nextBlink = t + 3.2 + this.random() * 2.8
    }
    const phase = (t - this.blinkStart) / .28
    const open = phase >= 0 && phase <= 1 ? 1 - Math.sin(Math.PI * phase) ** 2 : 1
    const a = reduced ? 0 : 1
    const pose = {
      ParamAngleX: a * (Math.sin(t * .53) * 5.5 + this.focus[0] * 6),
      ParamAngleY: a * (Math.sin(t * .41) * 2.5 - this.focus[1] * 2),
      ParamAngleZ: a * Math.sin(t * .36) * 3.5,
      ParamBodyAngleX: 0, ParamBodyAngleY: 0,
      ParamBodyAngleZ: a * Math.sin(t * .36) * .9,
      ParamBreath: a * (.35 + Math.sin(t * 1.35) * .28),
      ParamEyeLOpen: open, ParamEyeROpen: open,
      ParamEyeBallX: a * this.focus[0] * .15,
      ParamEyeBallY: -a * this.focus[1] * .1,
      ParamHairBack: a * Math.sin(t * .76) * .55,
      ParamHairBack2: a * Math.sin(t * .76 - .4) * .42,
      ParamHairBack3: a * Math.sin(t * .76 - .8) * .3,
      ParamHairPitch: a * Math.sin(t * .65) * .28,
      ParamArmL: a * Math.sin(t * .82) * .18,
      ParamArmR: a * Math.sin(t * .82 + .6) * .18,
      ParamWristL: a * Math.sin(t * .82 - .5) * .1,
      ParamWristR: a * Math.sin(t * .82 + .1) * .1,
      ParamFingerCurlL: a * (.04 + Math.sin(t * .49) * .025),
      ParamFingerCurlR: a * (.04 + Math.sin(t * .49 + 1) * .025),
      ParamMouthOpenY: 0,
      ParamElbowL: 0, ParamElbowR: 0,
    }
    for (const [id, value] of Object.entries(this.gestures.sample_action(t, reduced)))
      pose[id] = (pose[id] || 0) + value
    pose.ParamHairFront = this.hair.sample_motion(dt, pose.ParamAngleX, pose.ParamAngleZ, reduced)
    if (this.preview) {
      pose.ParamEyeLOpen = 1 - this.preview[0]
      pose.ParamEyeROpen = 1 - this.preview[1]
      pose.ParamMouthOpenY = this.preview[2]
    }
    return pose
  }
}
