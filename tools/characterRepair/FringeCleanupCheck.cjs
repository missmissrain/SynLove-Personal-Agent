/**
 * 刘海去污染验收：对照同一相机和姿态的修前修后图，并检查嘴眼与小幅转头。
 * 参数url/output为本机原型与证据目录；使用已有浏览器依赖，不调用任何模型。
 */
const fs = require('node:fs')
const path = require('node:path')
const {chromium} = require(process.env.SYNLOVE_PLAYWRIGHT || 'C:/Users/洪嘉锴/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

class FringeCleanupCheck {
  /** 参数url/output为本机页面和输出位置，截图采用2倍屏对照细发梢。 */
  constructor(url, output) { this.url=url; this.output=output }

  /** 无参数；实际编译材质，对照开关和眨眼状态，记录真实浏览器错误。 */
  async run_checks() {
    const browser = await chromium.launch({headless:true,channel:'msedge'})
    const errors=[]
    const states=[
      ['刘海补色关闭对照',0,0,0], ['刘海去污染后',1,0,0],
      ['刘海半闭眼',1,.5,0], ['刘海闭眼',1,1,0],
      ['刘海左转',1,0,-.10], ['刘海右转',1,0,.10],
    ]
    fs.mkdirSync(this.output,{recursive:true})
    try {
      const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2})
      page.on('pageerror',error=>errors.push(error.message))
      page.on('console',message=>{if(message.type()==='error') errors.push(message.text())})
      await page.goto(this.url)
      await page.waitForFunction(()=>window.synlovePrototype?.avatar.loaded)
      for(const [name,enabled,blink,yaw] of states) {
        await page.evaluate(({enabled,blink,yaw})=>{
          const a=window.synlovePrototype.avatar
          a.renderer.setAnimationLoop(null)
          a.motion.update_motion(0,true)
          a.controls.value.set(blink,blink,0)
          a.figure.rotation.y=yaw
          let found=0
          for(const mesh of a.figure.children) {
            const value=mesh.material.uniforms.fringeCleanup
            if(value) { value.value=enabled; found++ }
          }
          if(found!==2) throw new Error('主体与独立精修刘海的材质修正数量不匹配')
          a.renderer.render(a.scene,a.camera)
        },{enabled,blink,yaw})
        await page.screenshot({path:path.join(this.output,`${name}.png`),
          clip:{x:640,y:215,width:220,height:110}})
      }
      const eyeLine = await this.check_eye_line(page)
      if(errors.length) throw new Error(errors.join('\n'))
      const report={ok:true,states:states.map(state=>state[0]),eyeLine,errors}
      fs.writeFileSync(path.join(this.output,'刘海去污染验证.json'),JSON.stringify(report,null,2))
      console.log(JSON.stringify(report))
    } finally { await browser.close() }
  }

  /** 参数page为已加载原型；确认修补影响睁眼局部，但完全不改变闭眼渲染。 */
  async check_eye_line(page) {
    const frames=[]
    for(const [blink,enabled] of [[0,0],[0,1],[1,0],[1,1]]) {
      await page.evaluate(({blink,enabled})=>{
        const a=window.synlovePrototype.avatar
        a.controls.value.set(blink,blink,0)
        a.figure.rotation.y=0
        for(const mesh of a.figure.children) {
          const value=mesh.material.uniforms.eyeLineRepair
          if(value) value.value=enabled
        }
        a.renderer.render(a.scene,a.camera)
      },{blink,enabled})
      frames.push(await page.screenshot({clip:{x:680,y:225,width:45,height:50}}))
    }
    const result={openChanged:!frames[0].equals(frames[1]),
      closedUnchanged:frames[2].equals(frames[3])}
    if(!result.openChanged || !result.closedUnchanged) throw new Error('眼线修补的睁闭眼隔离检查失败')
    return result
  }
}
new FringeCleanupCheck(process.argv[2] || 'http://127.0.0.1:3090/prototype/character-driven/',
  process.argv[3] || 'artifacts/characterRepair').run_checks()
  .catch(error=>{console.error(error);process.exitCode=1})
