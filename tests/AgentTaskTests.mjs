/**
 * 任务隔离回归：使用现有 Harness、真实 MCP SDK、临时数据库及可控假模型，不连接消息平台。
 * 参数：node --test tests/AgentTaskTests.mjs；所有数据保存在系统临时目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskStore } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskStore.js'
import { TaskRuntime } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskRuntime.js'
import { TaskResultCollector } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskResultCollector.js'
import { QqOutbox } from '../backend/packages/webhook/webhook-qq/lib/types/QqOutbox.js'
const require = createRequire(join(process.cwd(),'backend/package.json'))
const { Context } = require('@deepseek-ai/cordis')
const { assembleContextFor } = require('@deepseek-ai/dsh-agent')
const { LlmAdapter, createUserMessage } = require('@deepseek-ai/dsh-llm')
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client')

/** predicate 为可验证条件，ms 为超时；有界等待真实异步结果。 */
async function wait_for(predicate, ms=4000) {
  const end = Date.now()+ms
  while (!predicate()) { if (Date.now()>end) throw Error('等待条件超时'); await delay(10) }
}
/** 无参数；准备临时配置和提示词，不读取生产聊天数据。 */
function make_root() {
  const root=mkdtempSync(join(tmpdir(),'synlove-agent-task-'))
  mkdirSync(join(root,'prompts'))
  for (const name of ['PresenterProtocol.md','TaskExecution.md','WorkerProtocol.md'])
    copyFileSync(join(process.cwd(),'prompts',name),join(root,'prompts',name))
  return root
}
/** 无参数；实际 Harness 内核与协议注册，模型仅返回固定正文。 */
async function make_native(control={}) {
  const ctx = new Context()
  for (const name of ['session','session-projection','system-prompt','tools','agent','llm','agent-loop','mcp-resources']) {
    const config = name==='system-prompt' ? { personaPrefix:'测试人格', includeRuntimeContext:false }
      : name==='tools' ? {mode:control.mode??'native'} : name==='agent-loop' ? {agents:[]} : undefined
    await ctx.plugin(require('@deepseek-ai/dsh-'+name).default, config)
  }
  class FixtureAdapter extends LlmAdapter {
    /** options 为真实内核请求；检查工具隔离并返回可验证输出。 */
    async *stream(options) {
      await control.before_stream?.(options)
      const isResult=options.messages.some(m => JSON.stringify(m).includes('synlove-task-result'))
      if (!String(options.sessionId).startsWith('task-'))
        assert.equal(options.tools.length,5)
      yield {type:'text-delta',index:0,text:control.reply??(isResult?'查好啦，验证结果在这里。':'TASK_OUTCOME: succeeded\n隔离执行总结：检查通过，无外部操作。')}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new FixtureAdapter())
  return ctx
}

test('任务状态幂等、跨用户隔离、单租约和崩溃恢复', () => {
  const root=make_root(), path=join(root,'tasks.db'), a=new TaskStore(path), b=new TaskStore(path)
  try {
    assert.ok(a.claim_lease('a')); assert.equal(b.claim_lease('b'),false)
    const task=a.create_task('u','key',{channel:'qq'},'检查','research')
    assert.equal(a.create_task('u','key',{},'检查','research').id,task.id)
    assert.throws(()=>b.get_task(task.id,'other'),/不属于/)
    a.update_task(task.id,{state:'running'})
    a.recover_tasks()
    assert.equal(a.get_task(task.id,'u').state,'interrupted')
    assert.equal(a.get_task(task.id,'u').queued,0)
    // 明确不存在的系统 PID 才可提前接管，旧 owner 后续写入必须被隔离。
    a.db.prepare('UPDATE taskLease SET pid=? WHERE owner=?').run(2147483647,'a')
    assert.equal(b.claim_lease('b'),true)
    assert.equal(a.has_lease('a'),false)
  } finally { a.close_store();b.close_store();rmSync(root,{recursive:true,force:true}) }
})

test('双端同轮输入必须明确来源，不能把微信任务发给最近的QQ目标', async () => {
  const root=make_root(),runtime=new TaskRuntime({},root,{maxConcurrent:1})
  const events=[]
  const agent={id:'shared',session:{snapshotEvents:()=>events}}
  const owner={agent,session:'shared',options:{workspace_path:root}}
  runtime.pump_tasks=async()=>{}
  try {
    events.push({type:'turn/start',data:{turn:1}})
    for(const channel of ['weixin','qq']) {
      const key=runtime.note_input(agent,{channel,messageId:'same-turn',owner:'house',userId:'owner',workspace:root,originalText:channel+'的任务'})
      events.push({type:'user/message',data:{source:{taskOriginId:key}}})
    }
    await assert.rejects(runtime.call_tool(owner,'task_submit',{request:'微信发来的任务'}),/多个消息来源/)
    await assert.rejects(runtime.call_tool(owner,'task_submit',{request:'测试',originId:'forged'}),/不属于本轮/)
    const accepted=await runtime.call_tool(owner,'task_submit',{request:'微信发来的任务',originId:'weixin:same-turn'})
    assert.equal(runtime.store.get_task(accepted.taskId,'house').origin.channel,'weixin')
  } finally {await runtime.close_runtime();rmSync(root,{recursive:true,force:true})}
})

test('创建会话期间取消及超时也能终止，不能把启动失败报告为成功', async () => {
  const root=make_root()
  const factory={create_worker:async(_task,_options,signal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true})
  })}
  const runtime=new TaskRuntime({},root,{taskTimeoutMs:100,maxConcurrent:2},factory)
  const agent={id:'main',session:{snapshotEvents:()=>[{type:'user/message',data:{source:{taskOriginId:'qq:a'}}}]}}
  const owner={agent,session:'main',options:{workspace_path:root}}
  try {
    runtime.note_input(agent,{channel:'qq',messageId:'a',owner:'u',workspace:root})
    const a=runtime.store.create_task('u','a',{channel:'qq',workspace:root,options:{}},'取消','research')
    const b=runtime.store.create_task('u','b',{channel:'qq',workspace:root,options:{}},'超时','research')
    await runtime.pump_tasks()
    await runtime.call_tool(owner,'task_cancel',{taskId:a.id})
    await wait_for(()=>runtime.store.get_task(a.id,'u').state==='cancelled')
    await wait_for(()=>runtime.store.get_task(b.id,'u').state==='interrupted')
    assert.equal(runtime.active.size,0)
  } finally {await runtime.close_runtime();rmSync(root,{recursive:true,force:true})}
})

test('正常结束与目标成功分开：失败、需确认和缺结论均不能标成功', async () => {
  const control={},ctx=await make_native(control)
  const collector=new TaskResultCollector()
  let handle
  try {
    handle=await ctx.agents.create({sessionId:'task-outcome-test',agentOptions:{provider:'fixture',model:'fixture'}})
    for(const [reply,state] of [['TASK_OUTCOME: failed\n文件打不开','failed'],
      ['TASK_OUTCOME: needs_input\n缺少用户授权','partial'],['没有明确结论','partial']]) {
      control.reply=reply
      const boundary=handle.agent.session.snapshotEvents().length
      handle.agent.followup(createUserMessage({content:[{type:'text',text:'核对结论'}],source:{kind:'user'}}))
      await handle.agent.whenIdle()
      assert.equal(collector.collect_result(handle.agent,boundary,false,true).state,state)
    }
  } finally {await handle?.dispose();await ctx.fiber.dispose()}
})

test('双端60任务并发有界，主人格仍可对话，定向取消不影响其他任务', async () => {
  const root=make_root(), gates=new Map(), started=[]
  const ctx=await make_native({before_stream:async options=>{
    if (!String(options.sessionId).startsWith('task-')) return
    started.push(options.sessionId)
    await new Promise(resolve=>{
      gates.set(options.sessionId,resolve)
      options.signal.addEventListener('abort',resolve,{once:true})
    })
  }})
  ctx.provide('agentPresets',{resolve:async()=>({id:'task-worker'}),mount:async()=>{}})
  const runtime=new TaskRuntime(ctx,root,{workerPreset:'task-worker',maxConcurrent:2,taskTimeoutMs:5000})
  const options={provider:'fixture',model:'fixture',workspace_path:root}
  let main
  try {
    main=await ctx.agents.create({sessionId:'main-concurrency',agentOptions:options})
    await runtime.attach_presenter(main.agent,options)
    runtime.note_input(main.agent,{channel:'qq',messageId:'cancel',owner:'u',workspace:root})
    main.agent.followup(createUserMessage({content:[{type:'text',text:'普通聊天'}],source:{kind:'user',taskOriginId:'qq:cancel'}}))
    await main.agent.whenIdle()
    const tasks=[]
    for(let i=0;i<60;i++) tasks.push(runtime.store.create_task('u','task-'+i,
      {channel:i%2?'qq':'weixin',workspace:root,options},'隔离并发检查','research'))
    await runtime.pump_tasks()
    await wait_for(()=>started.length===2)
    assert.equal(runtime.active.size,2)
    main.agent.followup(createUserMessage({content:[{type:'text',text:'后台继续，我再聊一句'}],source:{kind:'user',taskOriginId:'qq:cancel'}}))
    await main.agent.whenIdle()
    assert.equal(runtime.active.size,2)
    const cancelled=tasks[0]
    await runtime.call_tool({agent:main.agent,session:main.agent.id,options},'task_cancel',{taskId:cancelled.id})
    await wait_for(()=>runtime.store.get_task(cancelled.id,'u').state==='cancelled')
    assert.equal(runtime.store.get_task(tasks[1].id,'u').state,'running')
    await wait_for(()=>started.length===3)
    assert.equal(runtime.active.size,2)
    // 只取消测试剩余排队项，再放行其他真实内核执行会话。
    for(const task of tasks.slice(3)) runtime.store.update_task(task.id,{state:'cancelled'})
    for(const resolve of gates.values()) resolve()
    await wait_for(()=>runtime.active.size===0)
    assert.equal(runtime.store.get_task(tasks[1].id,'u').state,'succeeded')
  } finally {await runtime.close_runtime();await main?.dispose();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('QQ 完成通知发送后重启依然幂等，不重复发送', async () => {
  const root=make_root(), path=join(root,'qq.json')
  let sent=0
  const send=async()=>{sent++;return {ok:true,mode:'active'}}
  try {
    const queue=new QqOutbox(path,send,()=>{})
    const reply={text:'完成',target:{kind:'c2c',id:'fixture'},dedupeKey:'task-one'}
    const id=queue.enqueue_reply(reply)
    assert.equal(queue.enqueue_reply(reply),id)
    await queue.drain_queue()
    const next=new QqOutbox(path,send,()=>{})
    assert.equal(next.enqueue_reply(reply),id)
    await next.drain_queue()
    assert.equal(sent,1)
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('实际 MCP SDK 五工具、鉴权、中文、幂等提交和模型自然回复指令', async () => {
  const root=make_root(), runtime=new TaskRuntime({},root,{maxConcurrent:1})
  const agent={id:'main',session:{snapshotEvents:()=>[{type:'user/message',data:{source:{taskOriginId:'qq:one'}}}]}}
  const origin={channel:'qq',messageId:'one',owner:'u',workspace:root}
  const owner={agent,session:'main',options:{workspace_path:root}}
  const token=runtime.mcp.bind_owner(owner)
  const client=new Client({name:'fixture',version:'1'},{capabilities:{},versionNegotiation:{mode:'auto'}})
  runtime.pump_tasks=async()=>{}
  try {
    runtime.note_input(agent,origin)
    await runtime.ready
    await client.connect(new StreamableHTTPClientTransport(new URL(runtime.mcp.url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}))
    assert.equal((await client.listTools()).tools.length,5)
    const a=await client.callTool({name:'task_submit',arguments:{request:'检查中文内容，不要改变文件',kind:'research'}})
    const first=JSON.parse(a.content[0].text)
    const second=JSON.parse((await client.callTool({name:'task_submit',arguments:{request:'检查中文内容，不要改变文件',kind:'research'}})).content[0].text)
    assert.equal(first.taskId,second.taskId);assert.equal(first.state,'queued')
    assert.match(first.replyInstruction,/自己的自然语气/)
    assert.equal(first.text,undefined)
    assert.equal((await fetch(runtime.mcp.url,{method:'POST',body:'{}'})).status,403)
    const denied=await client.callTool({name:'task_cancel',arguments:{taskId:'other'}})
    assert.equal(denied.isError,true)
  } finally {await client.close();await runtime.close_runtime();rmSync(root,{recursive:true,force:true})}
})

test('真实 Harness 主人格只见五工具、独立执行总结由原通道投递且不重复', async () => {
  const root=make_root(), ctx=await make_native({mode:'both'})
  const options={provider:'fixture',model:'fixture',workspace_path:root}
  // 工厂挂载接口按真实 setup(agentCtx, agent) 执行；实际预设解析在生产烟测复核。
  ctx.provide('agentPresets',{resolve:async()=>({id:'task-worker'}),mount:async()=>{}})
  const runtime=new TaskRuntime(ctx,root,{workerPreset:'task-worker',maxConcurrent:2})
  let main, sends=[]
  try {
    main=await ctx.agents.create({sessionId:'fixture-main',agentOptions:options})
    await runtime.attach_presenter(main.agent,options)
    assert.deepEqual(ctx.tools.schemas(main.agent).map(t=>t.name).sort(),
      runtime.mcp.list_tools().map(t=>'mcp__synlove-task__'+t.name).sort())
    runtime.note_input(main.agent,{channel:'qq',messageId:'one',owner:'u',workspace:root})
    main.agent.followup(createUserMessage({content:[{type:'text',text:'测试'}],source:{kind:'user',taskOriginId:'qq:one'}}))
    await main.agent.whenIdle()
    runtime.register_channel('qq',{resolve:async()=>main.agent,send:async(task,text)=>{sends.push({task,text});return task.id}})
    const reply=await runtime.call_tool({agent:main.agent,session:main.agent.id,options},'task_submit',{request:'检查测试',kind:'research'})
    await wait_for(()=>sends.length===1)
    const finished=runtime.store.get_task(reply.taskId,'u')
    assert.equal(finished.state,'succeeded',finished.result)
    assert.ok(sends[0].text.length)
    assert.equal(sends[0].text, '查好啦，验证结果在这里。')
    assert.doesNotMatch(sends[0].text, /TASK_OUTCOME/)
    await runtime.bridge.pump_results();assert.equal(sends.length,1)
    assert.equal(runtime.active.size,0)
    assert.equal(runtime.is_presenting(main.agent.id),false)
  } finally {await runtime.close_runtime();await main?.dispose();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('执行提示词独立加载，编辑后仅新任务采用，固定协议仍存在', async () => {
  const root=make_root(), ctx=await make_native()
  ctx.provide('agentPresets',{resolve:async()=>({id:'task-worker'}),mount:async()=>{}})
  const runtime=new TaskRuntime(ctx,root,{workerPreset:'task-worker'})
  const options={provider:'fixture',model:'fixture'}
  let first,second
  try {
    writeFileSync(join(root,'prompts','TaskExecution.md'),'执行人格甲：精确操作、详细验证。')
    first=await runtime.factory.create_worker({worker:'task-persona-a',kind:'research',origin:{workspace:root}},options)
    writeFileSync(join(root,'prompts','TaskExecution.md'),'执行人格乙：按验收条件输出。')
    second=await runtime.factory.create_worker({worker:'task-persona-b',kind:'research',origin:{workspace:root}},options)
    const sections=async agent=>(await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections
    const a=await sections(first.agent), b=await sections(second.agent)
    assert.equal(a.find(s=>s.name==='deployment:persona-prefix').text,'执行人格甲：精确操作、详细验证。')
    assert.equal(b.find(s=>s.name==='deployment:persona-prefix').text,'执行人格乙：按验收条件输出。')
    assert.match(b.find(s=>s.name==='synlove:worker-protocol').text,/TASK_OUTCOME/)
    assert.doesNotMatch(b.find(s=>s.name==='deployment:persona-prefix').text,/测试人格/)
  } finally {await first?.dispose();await second?.dispose();await runtime.close_runtime();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('主人格失败不透传原始总结，保留待办，恢复后仅发送润色正文', async () => {
  const root=make_root(), ctx=await make_native()
  const runtime=new TaskRuntime(ctx,root,{})
  let sent=[], attempts=0
  const agent={id:'fixture-presenter',status:'idle'}
  try {
    const task=runtime.store.create_task('u','result-failure',{channel:'qq'},'测试','research')
    runtime.store.update_task(task.id,{state:'succeeded',result:'TASK_OUTCOME: succeeded\n原始执行总结'})
    runtime.register_channel('qq',{resolve:async()=>agent,send:async(_task,text)=>{sent.push(text);return 'receipt'}})
    runtime.bridge.present_result=async()=>{attempts++;throw Error('模型暂时不可用')}
    await runtime.bridge.pump_results()
    assert.equal(attempts,1);assert.equal(sent.length,0)
    assert.equal(runtime.store.get_task(task.id,'u').queued,0)
    assert.equal(runtime.store.get_task(task.id,'u').notice,null)
    await runtime.bridge.pump_results();assert.equal(attempts,1)
    runtime.bridge.retries.clear()
    runtime.bridge.present_result=async()=>{attempts++;return '检查好啦，结果没有问题。'}
    await runtime.bridge.pump_results()
    await runtime.bridge.pump_results()
    assert.deepEqual(sent,['检查好啦，结果没有问题。'])
    assert.equal(runtime.store.get_task(task.id,'u').queued,1)
  } finally {await runtime.close_runtime();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('主人格未正式完成时抛错，超时不返回原始总结或半截回复', async () => {
  const root=make_root(), runtime=new TaskRuntime({},root,{presentationTimeoutMs:15})
  let events=[], handler, cancelled=false
  const agent={id:'timeout-presenter',session:{snapshotEvents:()=>events},
    ctx:{on:(name,fn)=>{if(name==='session/event')handler=fn;return ()=>{}}},
    followup:()=>{},cancel:()=>{cancelled=true}}
  try {
    await assert.rejects(runtime.bridge.present_result(agent,{id:'one',state:'succeeded',result:'不允许透传的原文'}),/未完成结果整理/)
    assert.equal(cancelled,true);assert.equal(runtime.bridge.is_presenting(agent.id),false)
  } finally {await runtime.close_runtime();rmSync(root,{recursive:true,force:true})}
})

test('超时提出取消后，直到内核真正停稳仍屏蔽结果流', async () => {
  const root=make_root(), runtime=new TaskRuntime({},root,{presentationTimeoutMs:15})
  let idle
  const stopped=new Promise(resolve=>{idle=resolve})
  const agent={id:'slow-stop-presenter',session:{snapshotEvents:()=>[]},
    ctx:{on:()=>()=>{}},followup:()=>{},cancel:()=>{},whenIdle:()=>stopped}
  try {
    await assert.rejects(runtime.bridge.present_result(agent,{id:'slow',state:'failed',result:'原文'}),/未完成/)
    assert.equal(runtime.bridge.is_presenting(agent.id),true)
    idle()
    await wait_for(()=>!runtime.bridge.is_presenting(agent.id))
  } finally {idle();await runtime.close_runtime();rmSync(root,{recursive:true,force:true})}
})
