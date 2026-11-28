/**
 * 自动回应动作：提供九种头部、肩部和手腕小动作，平滑进入并回到待机。
 * 参数time为动画累计秒；默认3.6至5.6秒，温和模式仅选头肩动作，不调用模型或业务工具。
 */
export class AvatarIdleActions {
  /** 无参数；记录当前动作及上一次类别，避免每次自动触发都做相同动作。 */
  constructor() {
    this.names=['nod','tilt','look','greet','shake','listen','peek','relax','wave']
    this.gentleNames=['nod','tilt','look','shake','listen','peek','relax']
    this.recent=[]
    this.name='nod'
    this.last=-1
    this.start=-100
    this.duration=3.6
  }

  /** 参数time为动画秒、name为可选动作名、gentle为温和模式；自动选择避开最近三个动作。 */
  start_action(time,name,gentle=false) {
    const allowed=gentle ? this.gentleNames : this.names
    const choices=allowed.filter(item=>!this.recent.includes(item))
    const selected=allowed.includes(name) ? name : choices[Math.floor(Math.random()*choices.length)]
    const index=this.names.indexOf(selected)
    this.last=index
    this.name=this.names[index]
    this.recent=[...this.recent,this.name].slice(-3)
    this.start=time
    this.duration=({look:4.8,listen:4.6,peek:5.2,relax:5.6,wave:4.2})[this.name] || 3.6
  }

  /** 参数time为当前秒；返回归一化包络和有限头臂偏移，动作起止偏移均为零。 */
  sample_action(time) {
    const phase=(time-this.start)/this.duration
    const active=phase>0 && phase<1
    const weight=active ? Math.sin(Math.PI*phase)**2 : 0
    const result={name:this.name,active,weight,nod:0,tilt:0,yaw:0,arm:0,elbow:0,wrist:0,
      armR:0,elbowR:0,wristR:0,chest:0,shoulder:0}
    if(this.name==='nod') result.nod=.045*weight*Math.sin(phase*Math.PI*2)
    if(this.name==='tilt') result.tilt=.045*weight
    if(this.name==='look') result.yaw=.045*weight*Math.sin(phase*Math.PI*2)
    if(this.name==='greet') {
      result.arm=.030*weight
      result.elbow=.035*weight
      result.wrist=.045*weight*Math.sin(phase*Math.PI*4)
      result.tilt=-.015*weight
    }
    // 所有偏移由零包络包住；不移动根骨，不改变手与袖口的绑定。
    if(this.name==='shake') {
      result.yaw=.065*weight*Math.sin(phase*Math.PI*4)
      result.tilt=.012*weight
    }
    if(this.name==='listen') {
      result.tilt=-.060*weight
      result.nod=.025*weight
      result.chest=.010*weight
    }
    if(this.name==='peek') {
      result.yaw=.075*weight*Math.sin(phase*Math.PI*2)
      result.tilt=-.030*weight*Math.sin(phase*Math.PI*2)
      result.nod=-.018*weight
    }
    if(this.name==='relax') {
      result.chest=-.012*weight
      result.shoulder=.018*weight
      result.nod=-.025*weight
    }
    if(this.name==='wave') {
      result.armR=.035*weight
      result.elbowR=.045*weight
      result.wristR=.065*weight*Math.sin(phase*Math.PI*6)
      result.tilt=.025*weight
    }
    return result
  }
}
