/**
 * 主子职责回归：真实Harness工具注册与任务管理器，使用固定模型和虚拟工具，不调用生产API。
 * 无参数；覆盖全量执行工具、主会话四项只读记忆、旧任务兼容和共享工作区互斥。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {TaskRuntime} from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskRuntime.js'
const require=createRequire(join(process.cwd(),'backend/package.json'))
const {Context}=require('@deepseek-ai/cordis')
const {LlmAdapter,createUserMessage}=require('@deepseek-ai/dsh-llm')
const {defineTool}=require('@deepseek-ai/dsh-tools')

/** 无参数；创建只包含公开提示词的临时测试工程。 */
function make_root() {
  const root=mkdtempSync(join(tmpdir(),'synlove-unified-'))
  mkdirSync(join(root,'prompts'))
  for(const name of ['PresenterProtocol.md','WorkerProtocol.md','TaskExecution.md'])
    copyFileSync(join(process.cwd(),'prompts',name),join(root,'prompts',name))
  return root
}
/** ctx为测试作用域，name为工具名；工具仅返回固定文本，没有真实副作用。 */
function add_tool(ctx,name) {
  return ctx.tools.register(defineTool({
    name,description:'隔离测试工具',parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>({text:value})},
    async execute() {return 'fixture'}
  }))
}
/** request为本地断言；准备真实Harness和固定响应模型，不读取生产记录。 */
async function make_context(request=()=>{}) {
  const ctx=new Context()
  for(const name of ['session','session-projection','system-prompt','tools','agent','llm','agent-loop','mcp-resources'])
    await ctx.plugin(require('@deepseek-ai/dsh-'+name).default,
      name==='system-prompt'?{personaPrefix:'测试欣爱',includeRuntimeContext:false}:
      name==='agent-loop'?{agents:[]}:name==='tools'?{mode:'native'}:undefined)
  class FixtureAdapter extends LlmAdapter {
    /** options为真实内核请求；执行断言后给出固定结果，零网络调用。 */
    async *stream(options) {
      request(options)
      yield {type:'text-delta',index:0,text:'查到啦，这件事记着呢。'}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new FixtureAdapter())
  return ctx
}

test('主人格实际模型请求具备四项记忆查询，控制工具被隔离',async()=>{
  const root=make_root(),seen=[]
  const ctx=await make_context(options=>seen.push(options.tools.map(t=>t.name)))
  for(const name of ['timeline_days','timeline_search','timeline_read','relation_query','pwsh','write'])
    add_tool(ctx,name)
  const runtime=new TaskRuntime(ctx,root,{})
  let main
  try {
    main=await ctx.agents.create({sessionId:'unified-main',agentOptions:{provider:'fixture',model:'fixture'}})
    await runtime.attach_presenter(main.agent,{})
    const names=ctx.tools.schemas(main.agent).map(t=>t.name)
    assert.equal(names.length,9)
    assert.ok(['timeline_days','timeline_search','timeline_read','relation_query'].every(n=>names.includes(n)))
    assert.ok(!names.includes('pwsh')&&!names.includes('write'))
    main.agent.followup(createUserMessage({content:[{type:'text',text:'上次说的事还记得吗'}],source:{kind:'user'}}))
    await main.agent.whenIdle()
    assert.equal(seen[0].length,9)
  } finally {await runtime.close_runtime();await main?.dispose();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('旧类别和旧toolAllow不再改变执行者能力，禁止直发和再派生',async()=>{
  const root=make_root(),ctx=await make_context()
  for(const name of ['read','write','edit','pwsh','opencode','codex','send_file','subagent'])
    add_tool(ctx,name)
  ctx.provide('agentPresets',{resolve:async()=>({id:'task-worker'}),mount:async()=>{}})
  const runtime=new TaskRuntime(ctx,root,{workerPreset:'task-worker',toolAllow:{research:['read']}})
  const handles=[]
  try {
    for(const kind of ['research','coding','operations','execution']) {
      const handle=await runtime.factory.create_worker({worker:'unified-'+kind,kind,origin:{workspace:root}},
        {provider:'fixture',model:'fixture'})
      handles.push(handle)
      const names=ctx.tools.schemas(handle.agent).map(t=>t.name)
      assert.ok(['read','write','edit','pwsh','opencode','codex'].every(n=>names.includes(n)),kind)
      assert.ok(!names.includes('send_file')&&!names.includes('subagent'))
    }
  } finally {for(const handle of handles)await handle.dispose();await runtime.close_runtime();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('MCP不再要求分类，旧请求kind可接收但统一落为execution',async()=>{
  const root=make_root(),runtime=new TaskRuntime({},root,{})
  runtime.pump_tasks=async()=>{}
  const agent={id:'main',session:{snapshotEvents:()=>[
    {type:'user/message',data:{source:{taskOriginId:'qq:unified'}}}]}}
  try {
    runtime.note_input(agent,{channel:'qq',messageId:'unified',owner:'house',workspace:root})
    const schema=runtime.mcp.list_tools().find(t=>t.name==='task_submit').inputSchema
    assert.equal(schema.properties.kind,undefined)
    const result=await runtime.call_tool({agent,session:'main',options:{}},'task_submit',
      {request:'检查服务，只读',kind:'research'})
    assert.equal(runtime.store.get_task(result.taskId,'house').kind,'execution')
  } finally {await runtime.close_runtime();rmSync(root,{recursive:true,force:true})}
})

test('旧research任务也不能并行写同一工作区，不同工作区仍可并发',async()=>{
  const root=make_root(),runtime=new TaskRuntime({},root,{maxConcurrent:2})
  const runs=[]
  runtime.run_task=async entry=>{runs.push(entry.task.id)}
  try {
    const a=runtime.store.create_task('u','one',{workspace:root},'一','research')
    runtime.store.create_task('u','two',{workspace:root},'二','research')
    const c=runtime.store.create_task('u','three',{workspace:join(root,'other')},'三','execution')
    await runtime.pump_tasks()
    assert.deepEqual(runs,[a.id,c.id])
    assert.equal(runtime.active.size,2)
    runtime.active.clear()
  } finally {await runtime.close_runtime();rmSync(root,{recursive:true,force:true})}
})
