/**
 * 头发随动控制器：叠加微风与转头惯性，通过阻尼弹簧输出独立刘海参数。
 * 注册参数无；默认摆幅不超过0.9，采用小步积分兼容低帧率，减少动态时立即归零。
 */
export class Live2dHairMotion {
  /** 无传入参数；初始化摆动时间、前次头部角度、刘海位移和速度。 */
  constructor() {
    this.time = 0
    this.previous = null
    this.value = 0
    this.speed = 0
  }

  /** 参数dt为秒、x/z为头部参数、reduced为减少动态；返回固定发根的刘海摆动量。 */
  sample_motion(dt, x, z, reduced = false) {
    if (reduced) {
      this.value = this.speed = 0
      this.previous = [x, z]
      return 0
    }
    const span = Math.min(Math.max(dt, 0), .5)
    if (!span) return this.value
    const last = this.previous || [x, z]
    const inertia = Math.max(-.28, Math.min(.28,
      -(x - last[0]) / span * .025 - (z - last[1]) / span * .018))
    this.previous = [x, z]
    const steps = Math.max(1, Math.ceil(span * 120)), step = span / steps
    for (let i = 0; i < steps; i++) {
      this.time += step
      const target = Math.sin(this.time * 1.12) * .52 +
        Math.sin(this.time * 1.83 + .8) * .13 + inertia
      this.speed += ((target - this.value) * 20 - this.speed * 7) * step
      this.value += this.speed * step
    }
    return Math.max(-.9, Math.min(.9, this.value))
  }
}
