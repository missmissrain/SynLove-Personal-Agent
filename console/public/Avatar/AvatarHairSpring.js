/**
 * 发梢次级运动：用阻尼弹簧跟随头部转向，叠加很轻的空气扰动，禁止作用到脸部和发根。
 * 参数默认频率3.4Hz、阻尼比0.86、位移上限1.8毫米；不模拟完整发丝碰撞或布料。
 */
export class AvatarHairSpring {
  /** 无参数；四个通道分别记录左右发梢的侧向和前后位移。 */
  constructor() {
    this.position = new Float64Array(4)
    this.velocity = new Float64Array(4)
    this.lastYaw = 0
    this.peak = 0
  }

  /** 参数dt为秒、time为待机累计秒、yaw为头部弧度；固定小步积分并限制最大位移。 */
  update_motion(dt, time, yaw) {
    const rate = Math.max(-.5,Math.min(.5,(yaw-this.lastYaw)/Math.max(.001,dt)))
    this.lastYaw = yaw
    const targets = [
      -.003*rate + .0010*Math.sin(time*1.7),
      .00045*Math.sin(time*1.1+.7),
      -.003*rate + .0009*Math.sin(time*1.5+.9),
      .00040*Math.sin(time*1.3+1.8),
    ]
    const steps = Math.max(1,Math.ceil(dt*120))
    const step = dt/steps
    const omega = 2*Math.PI*3.4
    for (let n=0;n<steps;n++) {
      for (let i=0;i<4;i++) {
        this.velocity[i] += (omega*omega*(targets[i]-this.position[i])
          -2*.86*omega*this.velocity[i])*step
        const next = this.position[i]+this.velocity[i]*step
        this.position[i] = Math.max(-.0018,Math.min(.0018,next))
        if (next!==this.position[i]) this.velocity[i] = 0
        this.peak = Math.max(this.peak,Math.abs(this.position[i]))
      }
    }
    return this.position
  }

  /** 参数yaw为当前头部角度；恢复页面、减少动态或手动固定画面时消除历史惯性。 */
  reset_motion(yaw = 0) {
    this.position.fill(0)
    this.velocity.fill(0)
    this.lastYaw = yaw
  }
}
