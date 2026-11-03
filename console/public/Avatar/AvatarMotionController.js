/**
 * 骨骼待机控制：驱动头颈、胸肩和手臂，管理指针轻跟随、短回应与发梢次级运动。
 * 参数THREE为固定版本渲染库、spec为已校验骨架；默认小幅待机、无全身漂浮、不调用模型。
 */
import { AvatarHairSpring } from './AvatarHairSpring.js'
import { AvatarIdleActions } from './AvatarIdleActions.js'

export class AvatarMotionController {
  /** 参数THREE/spec为渲染库与骨骼清单；使用原绑定逆矩阵保持认可的垂臂外观。 */
  constructor(THREE, spec) {
    if (!Array.isArray(spec) || !spec.length || spec.length>128) throw new Error('人物骨架不完整')
    this.THREE = THREE
    this.bones = []
    this.byName = new Map()
    this.inverse = []
    this.base = []
    for (const entry of spec) {
      if (entry.local?.length!==16 || entry.inverse?.length!==16 ||
        ![...entry.local,...entry.inverse].every(Number.isFinite)) throw new Error('骨骼矩阵无效')
      const bone = new THREE.Bone()
      bone.name = entry.name
      new THREE.Matrix4().fromArray(entry.local).decompose(bone.position,bone.quaternion,bone.scale)
      this.bones.push(bone)
      this.byName.set(entry.name,bone)
      this.base.push({ position:bone.position.clone(), quaternion:bone.quaternion.clone() })
      this.inverse.push(new THREE.Matrix4().fromArray(entry.inverse))
    }
    this.roots = []
    spec.forEach((entry,i) => {
      if (entry.parent<0) this.roots.push(this.bones[i])
      else {
        if (entry.parent>=i) throw new Error('骨架父子顺序无效')
        this.bones[entry.parent].add(this.bones[i])
      }
    })
    this.data = new Float32Array(spec.length*16)
    this.texture = new THREE.DataTexture(this.data,4,spec.length,THREE.RGBAFormat,THREE.FloatType)
    this.uniforms = {
      boneTexture:{value:this.texture}, boneCount:{value:spec.length},
      hairWind:{value:new THREE.Vector4()},
    }
    this.matrix = new THREE.Matrix4()
    this.euler = new THREE.Euler()
    this.delta = new THREE.Quaternion()
    this.hair = new AvatarHairSpring()
    this.actions = new AvatarIdleActions()
    this.time = 0
    this.gestureStart = -100
    this.nextGesture = 5+Math.random()*4
    this.nextLook = 0
    this.look = { x:0,y:0 }
    this.target = { x:0,y:0 }
    this.pointer = null
    this.state = {}
    this.update_motion(0,true)
  }

  /** 参数name/x/y/z为骨名与局部弧度；从原始姿态叠加旋转，不累计写回导致漂移。 */
  rotate_bone(name, x, y, z) {
    const bone = this.byName.get(name)
    if (!bone) return
    this.euler.set(x,y,z,'XYZ')
    bone.quaternion.multiply(this.delta.setFromEuler(this.euler))
  }

  /** 参数x/y为归一化指针或null；仅在人物展示区交互时设置小幅头部跟随。 */
  set_pointer(x, y) {
    this.pointer = x===null ? null : {
      x:Math.max(-1,Math.min(1,x)), y:Math.max(-1,Math.min(1,y)),
    }
  }

  /** 参数name为可选的有限动作名；自动模式选不同动作，保留独立验收入口。 */
  start_gesture(name) {
    this.gestureStart = this.time
    this.actions.start_action(this.time,name)
  }

  /** 参数dt为实际渲染间隔秒、still表示静止预览；dt限幅，暂停期间不推进动作时间。 */
  update_motion(dt, still = false) {
    dt = Math.max(0,Math.min(.05,dt))
    if (!still) this.time += dt
    for (let i=0;i<this.bones.length;i++) {
      this.bones[i].position.copy(this.base[i].position)
      this.bones[i].quaternion.copy(this.base[i].quaternion)
    }
    if (still) {
      this.look.x = this.look.y = 0
      this.hair.reset_motion()
      this.uniforms.hairWind.value.set(0,0,0,0)
      this.state = { headYaw:0,headTilt:0,arm:0,hairMax:0,still:true }
    } else {
      const t = this.time
      if (t>=this.nextLook) {
        this.target = {x:(Math.random()-.5)*1.1,y:(Math.random()-.5)*.65}
        this.nextLook = t+6+Math.random()*6
      }
      const target = this.pointer || this.target
      const follow = 1-Math.exp(-dt*1.4)
      this.look.x += (target.x-this.look.x)*follow
      this.look.y += (target.y-this.look.y)*follow
      if (t>=this.nextGesture) {
        this.start_gesture()
        this.nextGesture = t+10+Math.random()*8
      }
      const action=this.actions.sample_action(t)
      const breath = Math.sin(t*1.43)
      const yaw = .036*this.look.x+.009*Math.sin(t*.47)+action.yaw
      const tilt = .017*Math.sin(t*.63+.4)+.010*this.look.x+action.tilt
      const nod = .016*this.look.y+action.nod
      this.rotate_bone('Spine',.0025*breath,0,.002*Math.sin(t*.57))
      this.rotate_bone('Chest',.0045*breath,.003*Math.sin(t*.43),0)
      this.rotate_bone('Neck',nod*.32,yaw*.25,tilt*.28)
      this.rotate_bone('Head',nod*.68,yaw*.75,tilt*.72)
      this.rotate_bone('Shoulder.L',.0035*breath,0,.003*Math.sin(t*.8))
      this.rotate_bone('Shoulder.R',.0035*breath,0,-.003*Math.sin(t*.8))
      const arm = .055*Math.sin(t*.90+.8)
      this.rotate_bone('UpperArm.L',arm+action.arm,0,.018*Math.sin(t*.49))
      this.rotate_bone('UpperArm.R',-.050*Math.sin(t*.83+1.6),0,-.016*Math.sin(t*.51))
      this.rotate_bone('Forearm.L',.020*Math.sin(t*.90+.1)+action.elbow,0,0)
      this.rotate_bone('Forearm.R',.020*Math.sin(t*.83+1.0),0,0)
      this.rotate_bone('Hand.L',.012*Math.sin(t*.72)+action.wrist,0,0)
      this.rotate_bone('Hand.R',.010*Math.sin(t*.68+1.3),0,0)
      const hair = this.hair.update_motion(dt,t,yaw)
      this.uniforms.hairWind.value.set(...hair)
      this.state = {headYaw:yaw,headTilt:tilt,arm:arm+action.arm,action:action.name,
        actionActive:action.active,
        hairMax:Math.max(...hair.map(Math.abs)),still:false}
    }
    for (const root of this.roots) root.updateMatrixWorld(true)
    for (let i=0;i<this.bones.length;i++) {
      this.matrix.multiplyMatrices(this.bones[i].matrixWorld,this.inverse[i])
      this.matrix.toArray(this.data,i*16)
    }
    this.texture.needsUpdate = true
  }

  /** 无参数；释放矩阵纹理，避免多次初始化累积GPU资源。 */
  dispose_motion() { this.texture.dispose() }
}
