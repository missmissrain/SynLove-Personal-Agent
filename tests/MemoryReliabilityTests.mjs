/** 记忆功能回归：临时目录与假模型验证失败恢复、同毫秒游标及摘要幂等；无注册参数。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {TimelineStore} from '../backend/packages/webhook/webhook-weixin/lib/types/memory/timelineStore.js'
import {KnowledgeGraphStore} from '../backend/packages/webhook/webhook-weixin/lib/types/memory/graphStore.js'
import {start_graph_scheduler} from '../backend/packages/webhook/webhook-weixin/lib/types/memory/graphScheduler.js'
import {start_timeline_scheduler} from '../backend/packages/webhook/webhook-weixin/lib/types/memory/timelineScheduler.js'
import {create_memory_model} from '../backend/packages/webhook/webhook-weixin/lib/types/memory/memoryModel.js'

test('时间线千条去重、推理排除、索引重建与摘要失败恢复',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'synlove-memory-'))
  try {
    const store=new TimelineStore({dir,idle_ms:1,persist_reasoning:false})
    const ts=Date.now()-100000
    for(let i=0;i<1000;i++){
      const entry={id:`entry-${i}`,ts,role:'user',text:`人工测试记录${i}`,reasoning:'禁止保存'}
      assert.equal(store.append(entry),true)
      assert.equal(store.append(entry),false)
    }
    const date=store.list_days()[0].date
    assert.equal(store.read_day(date).entries.length,1000)
    assert.equal(store.read_day(date).entries[0].reasoning,undefined)
    writeFileSync(join(dir,'index.json'),'{broken')
    const recovered=new TimelineStore({dir,idle_ms:1})
    assert.equal(recovered.list_days()[0].entries,1000)
    recovered.update_summary(date,'旧摘要')
    recovered.append({id:'new',ts:ts+1,role:'assistant',text:'新记录'})
    assert.deepEqual(await recovered.summarize_due(async()=>{throw Error('模拟远端断网')}),[])
    assert.equal(recovered.read_summary(date),'旧摘要')
    assert.ok(recovered.days_needing_summary().includes(date))
    assert.deepEqual(await recovered.summarize_due(async()=>({text:'新摘要'})),[date])
    assert.equal(recovered.read_summary(date),'新摘要')
  }finally{rmSync(dir,{recursive:true,force:true})}
})

test('远端记忆模型鉴权错误、空正文和超时均拒绝假成功',async()=>{
  for(const status of [401,503]){
    const model=create_memory_model({engine:'local',fetch_impl:async()=>new Response('{}',{status})})
    await assert.rejects(()=>model.complete('测试'),/HTTP/)
  }
  const empty=create_memory_model({engine:'local',fetch_impl:async()=>new Response('{"choices":[]}')})
  await assert.rejects(()=>empty.complete('测试'),/有效正文/)
  const slow=create_memory_model({engine:'local',timeout_ms:10,fetch_impl:async(_url,{signal})=>
    new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout'))))})
  await assert.rejects(()=>slow.complete('测试'),/timeout/)
})

test('摘要调度捕获存储异常，阻止重入并可恢复',async()=>{
  let fail=true,release,calls=0
  const scheduler=start_timeline_scheduler({interval_ms:999999,store:{
    days_needing_summary:async()=>['2026-11-03'],
    summarize_due:async()=>{calls++;if(fail)throw Error('IO');return new Promise(r=>{release=r})},
  },summarizer:async()=>({text:'测试'})})
  try {
    assert.deepEqual(await scheduler.run_once(),[])
    fail=false
    const first=scheduler.run_once()
    assert.deepEqual(await scheduler.run_once(),[])
    release(['2026-11-03'])
    assert.deepEqual(await first,['2026-11-03'])
    assert.equal(calls,2)
  }finally{scheduler.stop()}
  assert.deepEqual(await scheduler.run_once(),[])
})

test('图谱远端失败不推进水位，同毫秒追加记录仍会更新',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'synlove-graph-'))
  const graph=new KnowledgeGraphStore({dir:join(dir,'graph')})
  const timeline=new TimelineStore({dir:join(dir,'timeline')})
  const ts=Date.now()-10000
  timeline.append({id:'one',ts,role:'user',text:'我的朋友叫测试小林。'})
  let fail=true,calls=0
  const scheduler=start_graph_scheduler({graph,timeline,idle_ms:1,interval_ms:999999,complete:async(prompt)=>{
    calls++;if(fail)throw Error('remote unavailable')
    return prompt.includes('【角色')?'无':(prompt.includes('整理成')?'人物|测试小林|\n关系|主人|测试小林|朋友':'无')
  }})
  try{
    assert.equal(await scheduler.run_once(),undefined)
    assert.equal(graph.last_update_ms(),undefined)
    fail=false
    assert.ok(await scheduler.run_once())
    assert.equal(graph.last_update_ms(),ts)
    const before=calls
    timeline.append({id:'two',ts,role:'user',text:'我喜欢摄影。'})
    assert.ok(await scheduler.run_once())
    assert.ok(calls>before)
    assert.ok(graph.last_update_ids().includes('two'))
  }finally{scheduler.stop();rmSync(dir,{recursive:true,force:true})}
})
