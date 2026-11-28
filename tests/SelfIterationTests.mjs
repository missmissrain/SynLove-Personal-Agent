/** 自迭代GUI设置回归：临时目录校验即时保存、设备与预算白名单，不接触计划任务。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SelfIterationStore } from '../console/SelfIterationStore.mjs'
test('默认天选优先，保存开关与预算不丢失仓库设置',()=>{
 const root=mkdtempSync(join(tmpdir(),'synlove-iteration-'))
 try {
  mkdirSync(join(root,'config'))
  const store=new SelfIterationStore(root)
  assert.equal(store.read_config().execution.primaryDevice,'tianxuanLaptop')
  assert.equal(store.read_config().execution.fallbackLocal,true)
  assert.equal(store.list_controls().length,10)
  store.save_setting('skillEnabled','0')
  store.save_setting('primaryDevice','server')
  store.save_setting('timeoutSec','1800')
  const c=JSON.parse(readFileSync(store.path))
  assert.equal(c.skillEnabled,false)
  assert.equal(c.execution.primaryDevice,'server')
  assert.equal(c.execution.timeoutSec,1800)
  assert.throws(()=>store.save_setting('timeoutSec','999999'))
  assert.throws(()=>store.save_setting('primaryDevice','unknown'))
 } finally {rmSync(root,{recursive:true,force:true})}
})
