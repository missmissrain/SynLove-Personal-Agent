/**
 * 动作视频实录：使用已有Edge与Playwright录制四组真实WebGL视频，检测关节跳变和实际帧间隔。
 * 参数url/output为本机审阅页与产物目录；不安装依赖，不调用模型。
 */
const fs=require('node:fs')
const path=require('node:path')
const {chromium}=require(process.env.SYNLOVE_PLAYWRIGHT || 'C:/Users/洪嘉锴/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

class MotionFilmCheck {
  /** 参数url/output为同源审阅页和视频目录；仅写入本次动作验证产物。 */
  constructor(url,output) {this.url=url;this.output=output}

  /** 无参数；录制四组动作，并采样手势中段截图检查袖口形变。 */
  async run_checks() {
    fs.mkdirSync(this.output,{recursive:true})
    const browser=await chromium.launch({headless:true,channel:'msedge',
      args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']})
    const errors=[], films=[]
    try {
      const page=await browser.newPage({viewport:{width:1280,height:960},deviceScaleFactor:1})
      page.on('pageerror',error=>errors.push(error.message))
      page.on('console',msg=>{if(msg.type()==='error') errors.push(msg.text())})
      await page.goto(this.url)
      await page.waitForFunction(()=>window.motionReview?.avatar.loaded)
      console.log('模型加载完成，开始逐个录制')
      const demos=[
        ['自然待机与回望',[[.5,'settle'],[10.5,'look']],20],
        ['倾听与点头回应',[[.5,'listen'],[9.5,'nod']],17],
        ['招手与摊手介绍',[[.5,'greet'],[9.5,'present_right']],20],
        ['思考与说话手势',[[.5,'think'],[10.5,'explain']],21],
        ['动作中断与衔接',[[.5,'greet'],[3,'listen'],[5,'explain'],[8,'confirm'],[11,'relax']],16],
      ]
      for(const [name,schedule,seconds] of demos.filter(item=>!process.env.SYNLOVE_FILM_FILTER || item[0].includes(process.env.SYNLOVE_FILM_FILTER))) {
        console.log(`开始录制：${name}（${seconds}秒）`)
        const result=await page.evaluate(({schedule,seconds})=>window.motionReview.capture_film(schedule,seconds),{schedule,seconds})
        const {base64,frames,...rest}=result
        const stats={...rest,drawCallbacks:frames}
        fs.writeFileSync(path.join(this.output,`${name}.webm`),Buffer.from(base64,'base64'))
        films.push({name,...stats})
        console.log(`录制完成：${name}，${frames}次绘制，关节最大单帧旋转${stats.maxJointFrameRotation.toFixed(4)}rad`)
      }
      for(const name of ['greet','present_right','explain','think']) {
        await page.evaluate(name=>{
          const a=window.motionReview.avatar
          window.motionReview.play_action(name)
          a.renderer.setAnimationLoop(null)
          a.motion.update_motion(0,true)
          a.motion.actions.start_action(a.motion.time-2.8,name)
          for(let i=0;i<40;i++) a.motion.update_motion(1/60)
          a.controls.value.set(0,0,0)
          a.renderer.render(a.scene,a.camera)
        },name)
        await page.screenshot({path:path.join(this.output,`${name}姿态检查.png`)})
      }
      const reportPath=path.join(this.output,'动作实录验证.json')
      const previous=fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath,'utf8')).films || [] : []
      const merged=[...previous.filter(item=>!films.some(film=>film.name===item.name)),...films]
      fs.writeFileSync(reportPath,JSON.stringify({films:merged,errors},null,2))
      if(errors.length) throw new Error(errors.join('\n'))
      console.log(JSON.stringify({films,errors}))
    } finally {await browser.close()}
  }
}
new MotionFilmCheck(process.argv[2] || 'http://127.0.0.1:3090/prototype/character-driven/MotionReview.html',
  process.argv[3] || 'artifacts/motionReview').run_checks().catch(error=>{console.error(error);process.exitCode=1})
