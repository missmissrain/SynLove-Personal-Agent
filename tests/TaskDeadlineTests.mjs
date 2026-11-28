/**
 * 期限提醒集成回归：临时SQLite与受控通知器，验证原通道、持久重试、延期竞态和自动通知权限。
 * 不调用真实模型或消息平台；默认时钟可注入测试，不等待真实一小时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRuntime } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskRuntime.js'
import { TaskStore } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskStore.js'
import { TaskDeadlineMonitor } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskDeadlineMonitor.js'

/** setup为可选渲染/发送钩子；每次独立数据库并在finally清理。 */
async function with_fixture(setup, run) {
  const root = mkdtempSync(join(tmpdir(),'synlove-warning-'))
  let store = new TaskStore(join(root,'task.sqlite'))
  const task = store.create_task('wx-owner','fixture',{channel:'weixin',target:'wx-only'},'测试','execution')
  store.update_task(task.id,{state:'running'})
  const now=Date.now(),entry={task,startedAt:now-3360000,deadlineAt:now+240000}
  const sent=[],agent={id:'main',status:'idle'}
  let renders=0
  const runtime={root,config:{deadlineLeadMs:300000},store,active:new Map([[task.id,entry]]),
    channels:new Map([['weixin',{resolve:async()=>agent,send:async(t,text)=>{
      if(setup.send)await setup.send(t,text);sent.push({id:t.id,origin:t.origin,text});return 'queued'
    }}]]),progress:{read:()=>[{text:'第一步已保存，第二步尚未核验'}]},
    assert_owner:()=>{},log_event:()=>{}}
  const bridge={busy:new Set(),present_result:async(a,t)=>{
    renders++;if(setup.render)await setup.render(runtime,t,entry);return '还在做最后一步，再给一点时间吗？'
  }}
  const monitor=new TaskDeadlineMonitor(runtime,bridge)
  try {await run({runtime,bridge,monitor,task,entry,sent,renders:()=>renders,reopen:()=>{
    store.close_store();store=new TaskStore(join(root,'task.sqlite'));runtime.store=store
  }})} finally {store.close_store();rmSync(root,{recursive:true,force:true})}
}

test('一小时任务55分钟后才提醒，原微信通道投递且重开数据库不重复',async()=>{
  await with_fixture({},async f=>{
    f.entry.deadlineAt=Date.now()+600000
    await f.monitor.pump_notices();assert.equal(f.sent.length,0)
    f.entry.deadlineAt=Date.now()+240000
    await f.monitor.pump_notices()
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].origin.target,'wx-only')
    assert.match(f.sent[0].id,/:deadline:/);assert.notEqual(f.sent[0].id,f.task.id)
    assert.equal(f.runtime.store.get_task(f.task.id,'wx-owner').queued,0)
    f.reopen()
    await new TaskDeadlineMonitor(f.runtime,f.bridge).pump_notices()
    assert.equal(f.sent.length,1);assert.equal(f.renders(),1)
  })
})
test('发送失败后复用已保存正文，不重复调用主人格',async()=>{
  let tries=0
  await with_fixture({send:()=>{if(++tries===1)throw Error('断网')}},async f=>{
    await f.monitor.pump_notices();assert.equal(f.sent.length,0)
    f.monitor.retries.clear();await f.monitor.pump_notices()
    assert.equal(f.sent.length,1);assert.equal(f.renders(),1)
  })
})
for(const state of ['succeeded','cancelling','cancelled']) {
  test(`润色期间任务变为${state}时丢弃陈旧提醒`,async()=>{
    await with_fixture({render:(runtime,task)=>runtime.store.update_task(task.id,{state})},async f=>{
      await f.monitor.pump_notices();assert.equal(f.sent.length,0)
    })
  })
}
test('润色期间用户延期丢弃旧提醒，新期限临近可再次询问',async()=>{
  let first=true
  await with_fixture({render:(_runtime,_task,entry)=>{if(first){entry.deadlineAt+=3600000;first=false}}},async f=>{
    await f.monitor.pump_notices();assert.equal(f.sent.length,0)
    // 模拟新期限临近，保留不同的截止时间身份。
    f.entry.startedAt=Date.now()-3360000;f.entry.deadlineAt=Date.now()+230000
    await f.monitor.pump_notices();assert.equal(f.sent.length,1)
  })
})
test('过期与短任务刚开始不提醒，主人格忙时保留等待',async()=>{
  await with_fixture({},async f=>{
    f.entry.deadlineAt=Date.now()-1
    await f.monitor.pump_notices();assert.equal(f.sent.length,0)
    f.entry.startedAt=Date.now();f.entry.deadlineAt=Date.now()+60000
    await f.monitor.pump_notices();assert.equal(f.sent.length,0)
    f.entry.startedAt=Date.now()-3360000;f.entry.deadlineAt=Date.now()+240000
    f.bridge.busy.add('main');await f.monitor.pump_notices();assert.equal(f.sent.length,0)
    f.bridge.busy.clear();await f.monitor.pump_notices();assert.equal(f.sent.length,1)
  })
})
test('自动通知可查同一任务进度，禁止自动续时、列所有任务或跨会话读取',async()=>{
  const root=mkdtempSync(join(tmpdir(),'synlove-notice-auth-'))
  const runtime=new TaskRuntime({},root,{})
  try {
    assert.equal(runtime.config.taskTimeoutMs,3600000)
    const task=runtime.store.create_task('wx-owner','auth',{},'测试','execution')
    runtime.bridge.active.set('notice',{taskId:task.id,owner:'wx-owner'})
    const owner={session:'notice'}
    for(const name of ['task_status','task_progress','task_result'])
      assert.equal((await runtime.call_tool(owner,name,{taskId:task.id})).taskId,task.id)
    await assert.rejects(runtime.call_tool(owner,'task_message',{taskId:task.id,message:'自动延长',timeoutMs:7200000}),/不允许自动续时/)
    await assert.rejects(runtime.call_tool(owner,'task_status',{}),/必须指定/)
    await assert.rejects(runtime.call_tool(owner,'task_status',{taskId:'other'}),/其他任务/)
  } finally {await runtime.close_runtime();rmSync(root,{recursive:true,force:true})}
})
