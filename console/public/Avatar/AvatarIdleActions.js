/**
 * 自动回应动作：提供点头、侧头、左右看看和轻抬手四种有限姿态，平滑进入并回到待机。
 * 参数time为动画累计秒；默认动作3.6至4.8秒、不连续重复同一种，不调用模型或任何业务工具。
 */
export class AvatarIdleActions {
  /** 无参数；记录当前动作及上一次类别，避免每次自动触发都做相同动作。 */
  constructor() {
    this.names=['nod','tilt','look','greet']
    this.name='nod'
    this.last=-1
    this.start=-100
    this.duration=3.6
  }

  /** 参数time为动画秒、name为可选动作名；未指定时选取不同于上次的类别。 */
  start_action(time,name) {
    let index=this.names.indexOf(name)
    if(index<0) {
      const choices=this.names.map((_,i)=>i).filter(i=>i!==this.last)
      index=choices[Math.floor(Math.random()*choices.length)]
    }
    this.last=index
    this.name=this.names[index]
    this.start=time
    this.duration=this.name==='look' ? 4.8 : 3.6
  }

  /** 参数time为当前秒；返回归一化包络和有限头臂偏移，动作起止偏移均为零。 */
  sample_action(time) {
    const phase=(time-this.start)/this.duration
    const active=phase>0 && phase<1
    const weight=active ? Math.sin(Math.PI*phase)**2 : 0
    const result={name:this.name,active,weight,nod:0,tilt:0,yaw:0,arm:0,elbow:0,wrist:0}
    if(this.name==='nod') result.nod=.045*weight*Math.sin(phase*Math.PI*2)
    if(this.name==='tilt') result.tilt=.045*weight
    if(this.name==='look') result.yaw=.045*weight*Math.sin(phase*Math.PI*2)
    if(this.name==='greet') {
      result.arm=.030*weight
      result.elbow=.035*weight
      result.wrist=.045*weight*Math.sin(phase*Math.PI*4)
      result.tilt=-.015*weight
    }
    return result
  }
}
