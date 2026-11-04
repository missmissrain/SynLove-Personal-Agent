/**
 * 经用户授权的真实模型烟测：复用本机依赖与模型配置，只读取临时文件，不连接微信/QQ。
 * 参数：--live 必须显式传入；总预算上限 100000 token，额外限制每次输出 1024、最多12次请求。
 * 输出：runtime/agentTasks/真实模型验证.json，仅保存测试事实与模型正文，不记录密钥与服务地址。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskRuntime } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskRuntime.js'
import { TaskResultCollector } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskResultCollector.js'
import { WorkerSessionFactory } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/WorkerSessionFactory.js'
import { TaskReportStore } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskReportStore.js'
import { PersonaStore } from '../console/PersonaStore.mjs'

class AgentTaskLiveSmoke {
  /** 无参数；只使用现有兼容接口，不把密钥注入命令行。 */
  async run_test() {
    if (!process.argv.includes('--live')) throw Error('必须显式传入 --live')
    const remote = process.argv.includes('--remote-control')
    const reportSearch = process.argv.includes('--report-search')
    const require=createRequire(join(process.cwd(),'backend/package.json'))
    const { Context }=require('@deepseek-ai/cordis')
    const {createUserMessage}=require('@deepseek-ai/dsh-llm')
    const {createScope,scopeOf,bindScopeParent}=require('@deepseek-ai/dsh-scope')
    const config=JSON.parse(readFileSync('config/modelConfig.json','utf8'))
    const secret=JSON.parse(readFileSync('config/secrets.json','utf8'))
    const route=config.defaultModel, provider=config.providers[route.provider]
    const key=secret.providers?.[route.provider]?.apiKey
    if (!key) throw Error('当前路由缺少本机密钥')
    const root=mkdtempSync(join(tmpdir(),'synlove-live-task-'))
    mkdirSync(join(root,'prompts'))
    for(const name of ['PresenterProtocol.md','TaskExecution.md','WorkerProtocol.md'])
      copyFileSync(join(process.cwd(),'prompts',name),join(root,'prompts',name))
    writeFileSync(join(root,'sample.txt'),'烟测编号：SynLoveTask-Nov02。检查项：独立上下文、工具读取、原通道结果。')
    const ctx=new Context()
    let runtime,main,requests=0, input=0,output=0,reserved=0
    const sent=[], errors=[], events=[], runtimeEvents=[]
    try {
      for(const name of ['session','session-projection','system-prompt','tools','agent','llm','agent-loop','time-context','fs-local']) {
        const plugin=require('@deepseek-ai/dsh-'+name)
        await ctx.plugin(plugin.default ?? plugin,
          name==='system-prompt'?{personaPrefix:new PersonaStore(process.cwd()).read_persona().text,includeRuntimeContext:false}
            :name==='tools'?{mode:'native'}:name==='agent-loop'?{agents:[]}:undefined)
      }
      if (reportSearch) {
        await ctx.plugin(require('@deepseek-ai/dsh-web').default,{fetchProvider:'http',searchProvider:'deliberately-unconfigured'})
        await ctx.plugin(require('@deepseek-ai/dsh-web-fetch-http'))
      }
      ctx.provide('credentials',{resolve:async()=>({value:key})})
      await ctx.plugin(require('@deepseek-ai/dsh-llm-pi-ai'),{providers:{[route.provider]:{
        api:provider.api,baseURL:provider.baseURL,apiKeyEnv:'SYNLOVE_LIVE_TEST_KEY',
        models:[{id:route.model}],defaultContextWindow:65536,defaultMaxTokens:1024,
        timeoutMs:60000,streamIdleTimeoutMs:30000,
      }}})
      ctx.on('agent/request',async (_payload,next)=>{
        if(++requests>12 || input+output>70000) throw Error('烟测请求或预算上限')
        return next()
      })
      ctx.on('llm/stream',(options,next)=>{
        const estimate=Buffer.byteLength(JSON.stringify(options.messages)+JSON.stringify(options.tools))+2048
        // 时间插件每步追加上下文；字节预算只作为额外保护，仍保留12次请求与7万token上限。
        if(reserved+estimate>(reportSearch?500000:100000)) throw Error('保守字节预算上限')
        reserved+=estimate
        return next()
      })
      ctx.on('session/event',(_session,event)=>{
        events.push(event)
        const usage=event.data?.usage
        if(usage) {input+=usage.inputTokens??0;output+=usage.outputTokens??0}
      })
      ctx.on('agent/error',payload=>{errors.push(String(payload.error?.message??payload.error??'未知模型错误').replace(/https?:\/\/\S+/g,'[地址省略]'))})
      // 使用真实文件工具；预设挂载只复用本机模块，不产生新安装与外部通道。
      const standing={}, scope=createScope(ctx,standing)
      await scope.ctx.plugin(require('@deepseek-ai/dsh-tool-fs'))
      if (reportSearch) await scope.ctx.plugin(require('@deepseek-ai/dsh-tool-web'))
      ctx.provide('agentPresets',{resolve:async()=>({id:'task-worker'}),
        mount:async child=>{bindScopeParent(scopeOf(child),standing)}})
      const taskConfig=JSON.parse(readFileSync('config/agentTaskConfig.json','utf8'))
      const runConfig={...taskConfig,taskTimeoutMs:remote?240000:90000,presentationTimeoutMs:60000}
      const factory=remote?new WorkerSessionFactory(ctx,process.cwd(),runConfig):undefined
      runtime=new TaskRuntime(ctx,root,runConfig,factory)
      runtime.log_event=(name,data)=>{runtimeEvents.push({name,...data})}
      const options={...route,workspace_path:root,maxTokens:1024}
      main=await ctx.agents.create({sessionId:'isolated-live-presenter',agentOptions:options})
      await runtime.attach_presenter(main.agent,options)
      runtime.note_input(main.agent,{channel:'qq',messageId:'live-one',owner:'isolated',workspace:root})
      runtime.register_channel('qq',{resolve:async()=>main.agent,send:async(task,text)=>{sent.push({taskId:task.id,text});return task.id}})
      const boundary=main.agent.session.snapshotEvents().length
      main.agent.followup(createUserMessage({
        content:[{type:'text',text:remote
          ? '请提交一个operations后台任务：使用remote_cmd_list找到已经授权的homeServer，再用remote_cmd_run在这台家庭服务器执行只读CMD命令ver，返回真实Windows版本和退出码。只做这两步，不新增连接、不修改文件，不输出IP或凭据。提交后先自然告诉我已交给后台。'
          : reportSearch ? `请提交一个research后台烟测任务：先用web_search查询“Bing RSS”，确认真实搜索返回至少一个来源；再读取 ${join(root,'sample.txt')} 得到烟测编号。用save_report保存简短测试报告，内容包含真实来源链接、编号与“报告末尾验证”标记。三个工具各成功一次后就直接给出正式最终总结，不重复查询或读回报告；宿主测试程序负责逐字校验文件。最终总结简短，明确有无成功、编号、报告路径和限制。不要修改任何其他文件。接单回复一句即可。`
          : `请交给后台读取 ${join(root,'sample.txt')}，准确告诉我烟测编号。不要修改文件。提交后先自然告诉我接下来了。`}],
        source:{kind:'user',taskOriginId:'qq:live-one'},
      }))
      await main.agent.whenIdle()
      const ack=new TaskResultCollector().collect_result(main.agent,boundary)
      assert.equal(ack.state,'succeeded',JSON.stringify({summary:ack.result,reason:ack.reason,errors}))
      const tasks=runtime.store.list_tasks('isolated')
      assert.equal(tasks.length,1,'真实模型必须实际调用 MCP 派单')
      const end=Date.now()+(remote?300000:120000)
      while(!sent.length && Date.now()<end) {await runtime.pump_tasks();await delay(100)}
      assert.equal(sent.length,1,'完成事件必须实际进入隔离发送队列')
      const task=runtime.store.get_task(tasks[0].id,'isolated')
      assert.equal(task.state,'succeeded',task.result)
      assert.match(task.result,remote?/10\.0\.19045\.5131/:/SynLoveTask-Nov02/)
      assert.match(sent[0].text,remote?/19045|Windows 10/:/SynLoveTask-Nov02/)
      let artifacts
      if (reportSearch) {
        artifacts=new TaskReportStore(root).persist_result(task)
        assert.equal(artifacts.reportSaved,true,'必须用真实报告工具保存正文')
        const report=readFileSync(artifacts.reportPath,'utf8')
        assert.match(report,/SynLoveTask-Nov02/)
        assert.match(report,/报告末尾验证/)
        assert.match(report,/https?:\/\//)
        const calls=events.filter(event=>event.type==='tool/call').map(event=>event.data.name)
        assert.ok(calls.includes('save_report') && calls.includes('web_search'))
        assert.ok(sent[0].text.length<1200,'主人格不应把整篇报告搬到通知里')
      }
      if(remote) {
        const trace=JSON.stringify(events)
        assert.match(trace,/mcp__remote-cmd__remote_cmd_run/,'必须真实发起远控工具调用')
        assert.match(trace,/10\.0\.19045\.5131/,'远端版本必须出现在执行事件中')
      }
      assert.ok(input+output<100000)
      const report={date:new Date().toISOString(),model:`${route.provider}/${route.model}`,requests,
        reportedInputTokens:input,reportedOutputTokens:output,startReply:ack.text,
        workerSummary:task.result,finalReply:sent[0].text,queue:'isolated',remoteControl:remote,
        reportSearch,reportSaved:artifacts?.reportSaved,result:'PASS'}
      mkdirSync('runtime/agentTasks',{recursive:true})
      if(remote) writeFileSync('runtime/agentTasks/远控工具事件.json',JSON.stringify(events,null,2))
      writeFileSync(`runtime/agentTasks/${remote?'远控真实模型验证':reportSearch?'报告搜索真实模型验证':'真实模型验证'}.json`,JSON.stringify(report,null,2))
      console.log(JSON.stringify(report,null,2))
    } finally {
      mkdirSync('runtime/agentTasks',{recursive:true})
      writeFileSync('runtime/agentTasks/真实模型用量.json',JSON.stringify({
        time:new Date().toISOString(),requests,input,output,reserved,errors,
        runtimeEvents,
        tasks:runtime?.store.list_tasks('isolated').map(task=>({state:task.state,queued:task.queued,summary:task.result?.slice(0,1200)})),
        toolCalls:events.filter(event=>event.type==='tool/call').map(event=>event.data.name),
        toolErrors:events.filter(event=>event.type==='tool/result')
          .flatMap(event=>event.data.message?.content??[])
          .filter(block=>block.type==='tool-result' && block.isError)
          .map(block=>JSON.stringify(block.content).slice(0,300))
      },null,2))
      await runtime?.close_runtime();await main?.dispose();await ctx.fiber.dispose()
      rmSync(root,{recursive:true,force:true})
    }
  }
}
await new AgentTaskLiveSmoke().run_test()
