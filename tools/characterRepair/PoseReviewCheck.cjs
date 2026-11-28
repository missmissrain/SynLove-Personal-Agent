/**
 * 姿态与色彩实机检查：输出待机和手势截图及关节空间坐标，供改版前后比较。
 * 参数output为截图目录，默认artifacts/motionReviewV2；复用现有Edge和Playwright。
 */
const fs=require('node:fs')
const path=require('node:path')
const {chromium}=require('C:/Users/洪嘉锴/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

class PoseReviewCheck {
  /** 参数output为本次审阅产物目录；不会覆盖模型资产。 */
  constructor(output) {this.output=output}

  /** 无参数；固定视线和时间，逐个采样动作中段与默认站姿。 */
  async run_checks() {
    fs.mkdirSync(this.output,{recursive:true})
    const browser=await chromium.launch({headless:true,channel:'msedge'})
    try {
      const page=await browser.newPage({viewport:{width:1280,height:960}})
      await page.goto('http://127.0.0.1:3090/prototype/character-driven/MotionReview.html')
      await page.waitForFunction(()=>window.motionReview?.avatar.loaded)
      const results=[]
      for(const [name,label] of [['idle','默认姿态'],['greet','招手姿态'],['present_right','介绍姿态'],['look','转头姿态']]) {
        const result=await page.evaluate(name=>{
          const a=window.motionReview.avatar,m=a.motion
          a.renderer.setAnimationLoop(null)
          m.update_motion(0,true)
          m.time=0;m.nextGesture=Infinity;m.nextLook=Infinity;m.look={x:0,y:0};m.target={x:0,y:0}
          if(name==='idle') m.actions.start=-100
          else m.actions.start_action(0,name)
          for(let i=0;i<210;i++) m.update_motion(1/60)
          a.controls.value.set(0,0,0)
          a.renderer.render(a.scene,a.camera)
          return {name,handR:m.bones.find(b=>b.name==='Hand.R')?.matrixWorld.elements.slice(12,15)}
        },name)
        await page.locator('#motion-host').screenshot({path:path.join(this.output,`${label}.png`)})
        results.push(result)
      }
      fs.writeFileSync(path.join(this.output,'姿态采样.json'),JSON.stringify(results,null,2))
      console.log(JSON.stringify(results))
    } finally {await browser.close()}
  }
}
new PoseReviewCheck(process.argv[2] || 'artifacts/motionReviewV2').run_checks().catch(error=>{console.error(error);process.exitCode=1})
