/**
 * 任务交接回归：持久化时限、延长现有定时器、无正式总结时保留文件证据。
 * 参数无；使用临时数据库、真实文件与宿主方法，不调用模型或生产消息平台。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskStore } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskStore.js'
import { TaskRuntime } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskRuntime.js'
import { TaskEvidence } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskEvidence.js'
import { TaskResultCollector } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskResultCollector.js'

test('数据库时限跨重开保留，worker字段不受迁移影响', () => {
  const root=mkdtempSync(join(tmpdir(),'synlove-recovery-')),path=join(root,'tasks.sqlite')
  let store=new TaskStore(path)
  try {
    const task=store.create_task('owner','unique',{},'测试','research',3600000)
    assert.match(task.worker,/^task-/)
    store.close_store();store=new TaskStore(path)
    assert.equal(store.get_task(task.id,'owner').timeoutMs,3600000)
    store.update_task(task.id,{timeoutMs:7200000})
    assert.equal(store.get_task(task.id,'owner').timeoutMs,7200000)
  } finally {store.close_store();rmSync(root,{recursive:true,force:true})}
})

test('延长替换旧定时器，不重启会话，不重放任务', async () => {
  let cancels=0
  const entry={startedAt:Date.now(),abort:new AbortController(),handle:{agent:{cancel:()=>cancels++}}}
  try {
    TaskRuntime.prototype.arm_timeout(entry,120)
    await delay(25)
    TaskRuntime.prototype.arm_timeout(entry,260)
    await delay(120)
    assert.equal(cancels,0);assert.equal(entry.abort.signal.aborted,false)
    await delay(140)
    assert.equal(cancels,1);assert.equal(entry.timeout,true)
    assert.throws(()=>TaskRuntime.prototype.arm_timeout(entry,-1),/正整数/)
  } finally {clearTimeout(entry.timer)}
})

test('缺总结仍归档正式工具与文件，不把存在当内容验收', () => {
  const root=mkdtempSync(join(tmpdir(),'synlove-evidence-'))
  try {
    writeFileSync(join(root,'产物.txt'),'已保存')
    const events=[
      {type:'tool/call',data:{callId:'1',name:'write',arguments:JSON.stringify({path:'产物.txt'})}},
      {type:'tool/result',data:{message:{source:{callId:'1'},content:[{type:'tool-result',content:[{type:'text',text:'done'}]}]}}},
      {type:'tool/call',data:{callId:'2',name:'remote_file_transfer',arguments:{}}},
      {type:'tool/result',data:{message:{source:{callId:'2'},content:[{type:'tool-result',isError:true}]}}},
    ]
    const agent={session:{snapshotEvents:()=>events}}
    const evidence=new TaskEvidence(root).collect_evidence(agent,'fixture')
    assert.equal(evidence.toolCalls,2);assert.equal(evidence.explicitToolErrors,1)
    assert.equal(evidence.files[0].exists,true);assert.equal(evidence.files[0].contentVerified,false)
    assert.equal(JSON.parse(readFileSync(evidence.evidencePath,'utf8')).toolReturns,2)
    const result=new TaskResultCollector().collect_result(agent,0,true,true,[{text:'报告已存，传输失败'}])
    assert.match(result.result,/报告已存，传输失败/)
    assert.match(result.result,/不能据此判定全部失败/)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('task_message实际调整宿主期限并告知执行者，非法预算不生效', async () => {
  const root=mkdtempSync(join(tmpdir(),'synlove-deadline-'))
  const runtime=new TaskRuntime({},root,{},{create_worker:async()=>{throw Error('不应重建会话')}})
  runtime.current_origin=()=>({owner:'u'})
  const task=runtime.store.create_task('u','message-fixture',{},'测试','execution')
  runtime.store.update_task(task.id,{state:'running'})
  const messages=[]
  const entry={startedAt:Date.now()-100,abort:new AbortController(),handle:{agent:{
    steer:message=>messages.push(message),cancel:()=>{}
  }}}
  runtime.active.set(task.id,entry)
  try {
    const result=await runtime.call_tool({session:'s'},'task_message',{taskId:task.id,message:'继续完成',timeoutMs:3600000})
    assert.equal(runtime.store.get_task(task.id,'u').timeoutMs,3600000)
    assert.equal(result.deadlineAt,entry.startedAt+3600000)
    assert.match(JSON.stringify(messages),/宿主已调整任务总时限/)
    for (const value of [1,-1,7200001,true,'3600000']) {
      await assert.rejects(runtime.call_tool({session:'s'},'task_message',{taskId:task.id,message:'继续',timeoutMs:value}),/时限/)
    }
    assert.equal(messages.length,1)
    assert.equal(runtime.store.get_task(task.id,'u').timeoutMs,3600000)
  } finally {
    clearTimeout(entry.timer);runtime.active.delete(task.id)
    await runtime.close_runtime();rmSync(root,{recursive:true,force:true})
  }
})
