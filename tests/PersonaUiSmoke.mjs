/**
 * 双编辑器浏览器验证：真实页面脚本配合临时提示词存储，不修改生产人格、不调用模型。
 * 参数 argv[2] 为已安装 Playwright，argv[3] 为浏览器；页面默认取本机3082。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PersonaStore } from '../console/PersonaStore.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.argv[2] || 'playwright')
const root = mkdtempSync(join(tmpdir(), 'synlovePersonaUi-'))
for (const folder of ['config','prompts']) mkdirSync(join(root, folder))
writeFileSync(join(root,'config','weixinDoubaoProfile.patch.yml'), 'system-prompt:\n    personaPrefix: |\n      初始主人格\n    personaSuffix: |\n      保留后缀\n')
writeFileSync(join(root,'prompts','TaskExecution.md'), '初始执行人格')
const store = new PersonaStore(root)
let browser
try {
  browser = await chromium.launch({headless:true,executablePath:process.argv[3]})
  const page = await browser.newPage({viewport:{width:1440,height:1000}})
  const errors = []
  page.on('pageerror', error=>errors.push(error.message))
  await page.route('**/api/persona*',async route=>{
    const request=route.request(), url=new URL(request.url())
    try {
      const result=request.method()==='POST' ? store.save_persona(request.postDataJSON())
        : store.read_persona(url.searchParams.get('role') ?? 'presenter')
      await route.fulfill({json:result})
    } catch(error) {await route.fulfill({status:400,json:{error:error.message}})}
  })
  await page.goto('http://127.0.0.1:3082/')
  await page.locator('#tabs [data-tab="agent"]').click()
  await page.waitForFunction(()=>document.getElementById('worker-persona-text').value==='初始执行人格')
  assert.equal(await page.locator('#persona-text').inputValue(),'初始主人格')
  assert.equal(await page.locator('#worker-persona-text').isVisible(),false)
  await page.locator('[data-agent-view="worker"]').click()
  assert.equal(await page.locator('#worker-persona-text').isVisible(),true)
  await page.locator('#worker-persona-text').fill('尚未保存的执行编辑')
  await page.locator('[data-agent-view="main"]').click()
  await page.locator('#persona-text').fill('修改后的欣爱人格')
  await page.locator('#btn-save-persona').click()
  await page.waitForFunction(()=>document.getElementById('persona-hint').textContent.includes('已保存'))
  assert.equal(await page.locator('#worker-persona-text').inputValue(),'尚未保存的执行编辑')
  assert.equal(store.read_persona().text,'修改后的欣爱人格')
  assert.equal(store.read_persona('worker').text,'初始执行人格')
  await page.locator('[data-agent-view="worker"]').click()
  await page.locator('#btn-save-worker-persona').click()
  await page.waitForFunction(()=>document.getElementById('worker-persona-hint').textContent.includes('已保存'))
  assert.equal(store.read_persona('worker').text,'尚未保存的执行编辑')
  await page.locator('[data-agent-view="main"]').click()
  await page.locator('#persona-text').fill('主窗口未保存内容')
  await page.locator('[data-agent-view="worker"]').click()
  await page.locator('#btn-reload-worker-persona').click()
  assert.equal(await page.locator('#persona-text').inputValue(),'主窗口未保存内容')
  await page.locator('#worker-persona-text').fill('')
  await page.locator('#btn-save-worker-persona').click()
  await page.waitForFunction(()=>document.getElementById('worker-persona-hint').textContent.includes('失败'))
  assert.equal(store.read_persona('worker').text,'尚未保存的执行编辑')
  assert.deepEqual(errors,[])
  console.log('PASS：双编辑框读取、独立保存、未保存内容保护、重新读取、空提示词拒绝；无页面脚本错误。')
} finally {
  await browser?.close()
  rmSync(root,{recursive:true,force:true})
}
