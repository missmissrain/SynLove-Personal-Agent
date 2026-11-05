/**
 * 原型修缮验收：检查真实浏览器着色器、资源、交互与模拟十分钟动作稳定性。
 * 参数url/output为原型地址与证据目录；依赖已有Playwright，禁止安装依赖与调用模型。
 */
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.SYNLOVE_PLAYWRIGHT || 'C:/Users/洪嘉锴/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

class CharacterRepairCheck {
  /** 参数url/output为仅限本机原型地址和中文证据目录。 */
  constructor(url, output) { this.url=url; this.output=output }

  /** 无参数；验证实际渲染、三场景、中断动作连续性、资源格式与宽窄屏。 */
  async run_checks() {
    fs.mkdirSync(this.output, { recursive:true })
    const browser = await chromium.launch({ headless:true, channel:'msedge' })
    const errors = []
    try {
      const page = await browser.newPage({ viewport:{ width:1440,height:900 } })
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if(message.type()==='error') errors.push(message.text()) })
      await page.goto(this.url)
      await page.waitForFunction(() => window.synlovePrototype?.avatar.loaded)
      const result = await page.evaluate(() => {
        const a = window.synlovePrototype.avatar
        a.renderer.setAnimationLoop(null)
        const m = a.motion, clipNames=Object.keys(a.motion.actions.clips)
        let peak=0, maxStep=0
        m.update_motion(0,true)
        for(let i=0; i<36000; i++) {
          if(i%137===0) m.start_gesture(clipNames[Math.floor(i/137)%clipNames.length])
          const previous=m.bones.map(bone=>bone.quaternion.clone())
          m.update_motion(1/60)
          if(!m.data.every(Number.isFinite)) throw new Error('骨骼矩阵出现非有限值')
          for(let j=0;j<m.bones.length;j++) maxStep=Math.max(maxStep,previous[j].angleTo(m.bones[j].quaternion))
          peak=Math.max(peak,Math.abs(m.state.arm))
        }
        if(maxStep>.08) throw new Error(`动作切换跳变：${maxStep}`)
        const neutral = a.figure.children[0].geometry.getAttribute('position')
        const uv = a.figure.children[0].geometry.getAttribute('uv')
        let invalidUv=0
        for(let i=0; i<neutral.count; i++) if(uv.getX(i)===0 && uv.getY(i)===0) invalidUv++
        if(invalidUv) throw new Error('仍存在黑角UV')
        m.update_motion(0,true)
        a.controls.value.set(0,0,0)
        a.renderer.render(a.scene,a.camera)
        return { simulatedSeconds:600,maxFrameRotation:maxStep,maxArmChannel:peak,
          invalidUv,parts:a.figure.children.length,repair:a.manifest.repair,
          renderer:a.renderer.info.render,frames:a.frameCount }
      })
      await page.screenshot({ path:path.join(this.output,'修缮后待机.png') })
      for(const scene of ['usage','schedule','services']) {
        await page.click(`[data-intent="${scene}"]`)
        if(await page.locator('.scene-card').count()!==1) throw new Error('卡片重复挂载')
        await page.locator('.scene-close').click()
      }
      await page.locator('#command-input').fill('看看今天token用量')
      await page.locator('#command-form').evaluate(form=>form.requestSubmit())
      if(await page.locator('.scene-card h2').textContent()!=='今日用量') throw new Error('意图映射错误')
      await page.screenshot({ path:path.join(this.output,'修缮后卡片.png') })
      await page.setViewportSize({width:960,height:720})
      await page.screenshot({ path:path.join(this.output,'窄屏检查.png') })
      if(errors.length) throw new Error(errors.join('\n'))
      // 录制实际播放的动作，而非仅检查静态截图。
      const context = await browser.newContext({viewport:{width:1280,height:800},
        recordVideo:{dir:this.output,size:{width:1280,height:800}}})
      const videoPage = await context.newPage()
      await videoPage.goto(this.url)
      await videoPage.waitForFunction(()=>window.synlovePrototype?.avatar.loaded)
      await videoPage.click('[data-intent="usage"]')
      await videoPage.waitForTimeout(3400)
      await videoPage.click('[data-intent="schedule"]')
      await videoPage.waitForTimeout(3400)
      await videoPage.click('[data-intent="services"]')
      await videoPage.waitForTimeout(3400)
      const video=videoPage.video()
      await context.close()
      await video.saveAs(path.join(this.output,'预制动作与中断过渡.webm'))
      fs.writeFileSync(path.join(this.output,'原型修缮验证.json'),JSON.stringify({ok:true,...result,errors},null,2))
      console.log(JSON.stringify(result,null,2))
    } finally { await browser.close() }
  }
}
new CharacterRepairCheck(process.argv[2] || 'http://127.0.0.1:3090/prototype/character-driven/',
  process.argv[3] || 'artifacts/characterRepair').run_checks().catch(error=>{
    console.error(error);process.exitCode=1
  })
