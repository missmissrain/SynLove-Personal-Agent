/**
 * 双提示词持久化回归：临时文件验证角色隔离、中文换行、参数拒绝和配置保留。
 * 参数无；只使用固定假数据，不访问生产提示词、模型或消息平台。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonaStore } from '../console/PersonaStore.mjs'
import { SeparatePersonaPrompts } from '../tools/SeparatePersonaPrompts.mjs'

/** t 为测试上下文；构造带后续配置块的隔离提示词目录。 */
function make_store(t) {
  const root=mkdtempSync(join(tmpdir(),'synlovePersona-'))
  for(const folder of ['config','prompts']) mkdirSync(join(root,folder))
  writeFileSync(join(root,'config','weixinDoubaoProfile.patch.yml'),
    'system-prompt:\r\n    personaPrefix: |\r\n      原主人格\r\n\r\n      第二段\r\n    personaSuffix: |\r\n      固定后缀\r\nother: keep\r\n')
  writeFileSync(join(root,'prompts','TaskExecution.md'),'原执行人格')
  writeFileSync(join(root,'prompts','WorkerProtocol.md'),'固定协议，不可修改')
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const backups=[]
  return {root,backups,store:new PersonaStore(root,path=>backups.push(readFileSync(path,'utf8')))}
}

test('两个角色独立保存与重读，保留主配置其余内容和固定协议',t=>{
  const {root,store,backups}=make_store(t)
  const original=readFileSync(store.get_path('presenter'),'utf8')
  assert.equal(store.read_persona().text,'原主人格\n\n第二段')
  store.save_persona({role:'worker',text:'执行者：按事实说明。'})
  assert.equal(readFileSync(store.get_path('presenter'),'utf8'),original)
  store.save_persona({text:'欣爱：你好呀。\n\n严肃时认真。'})
  assert.equal(store.read_persona().text,'欣爱：你好呀。\n\n严肃时认真。')
  assert.equal(store.read_persona('worker').text,'执行者：按事实说明。')
  assert.match(readFileSync(store.get_path('presenter'),'utf8'),/    personaSuffix: \|\r\n      固定后缀\r\nother: keep/)
  assert.equal(readFileSync(join(root,'prompts','WorkerProtocol.md'),'utf8'),'固定协议，不可修改')
  assert.equal(backups.length,2)
  assert.equal(backups[0],'原执行人格')
  assert.equal(readdirSync(join(root,'prompts')).filter(name=>name.endsWith('.tmp')).length,0)
})

test('拒绝未知角色、路径伪装、空值、非字符串和超长提示词，不修改原文件',t=>{
  const {store}=make_store(t)
  for(const role of ['../../secrets','protocol','',{},1]) {
    assert.throws(()=>store.read_persona(role),/未知/)
    assert.throws(()=>store.save_persona({role,text:'不能写入'}),/未知/)
  }
  for(const text of ['', ' ', null, {}, '中'.repeat(90000)])
    assert.throws(()=>store.save_persona({role:'worker',text}))
  assert.equal(store.read_persona('worker').text,'原执行人格')
})

test('找不到主配置块时拒绝保存，不破坏原配置',t=>{
  const {store}=make_store(t)
  writeFileSync(store.get_path('presenter'),'other: keep\n')
  assert.throws(()=>store.save_persona({text:'新正文'}),/未做修改/)
  assert.equal(readFileSync(store.get_path('presenter'),'utf8'),'other: keep\n')
})

test('旧人格迁移保留性格与聊天，只删除底层操作章节，重复执行不变',()=>{
  const migration=new SeparatePersonaPrompts('unused')
  const source='你是欣爱，活泼，会认真。\n\n## 亲近、吐槽和玩笑\n保留原有语气。\n\n## 用技能\n调用 skill。\n\n## opencode 与工作区\n运行 opencode。\n\n## 回复节奏\n先听完。\n'
  const output=migration.split_text(source)
  assert.match(output,/你是欣爱，活泼，会认真/)
  assert.match(output,/保留原有语气/)
  assert.match(output,/先听完/)
  assert.doesNotMatch(output,/调用 skill|运行 opencode/)
  assert.match(output,/task_submit/)
  assert.equal(migration.split_text(output),output)
})
