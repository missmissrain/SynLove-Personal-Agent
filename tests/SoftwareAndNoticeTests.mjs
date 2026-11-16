/**
 * 软件与任务送达回归：使用临时数据库、真实队列和假发送器，验证旧凭据、暂存补发及送达追踪。
 * 参数无；不调用模型、不向微信或QQ发送消息。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinStateStore } from '../backend/packages/webhook/webhook-weixin/lib/types/state/weixinStateStore.js'
import { TurnContextStore } from '../backend/packages/webhook/webhook-weixin/lib/types/state/turnContextStore.js'
import { OutboundCoordinator } from '../backend/packages/webhook/webhook-weixin/lib/types/coordination/outboundCoordinator.js'
import { TaskStore } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskStore.js'
import { TaskNoticeTracker } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/TaskNoticeTracker.js'
import { PresenterEventBridge } from '../backend/packages/webhook/webhook-weixin/lib/types/agentTasks/PresenterEventBridge.js'
import { QqOutbox } from '../backend/packages/webhook/webhook-qq/lib/types/QqOutbox.js'

/** sender为假平台发送器；实际队列、上下文库均落在临时目录。 */
function make_fixture(sender) {
  const root = mkdtempSync(join(tmpdir(), 'synlove-notice-'))
  const store = new WeixinStateStore({ path:join(root,'state.db') })
  const context = new TurnContextStore(store)
  const outbound = new OutboundCoordinator({ store,turn_context:context,sender,classify_retryable:()=>false,
    send_min_gap_ms:0,send_batch_limit:20 })
  return { root,store,context,outbound,
    close() { outbound.stop();store.close();rmSync(root,{recursive:true,force:true}) } }
}

test('十五分钟前的入站凭据仍用于后台通知，平台成功才标sent', async () => {
  const sent = []
  const f = make_fixture(async input => sent.push(input))
  try {
    f.store.put_delivery_if_absent({delivery_id:'old',user_id:'u',received_at:Date.now()-15*60000,context_token:'fixture-old'})
    f.store.update_delivery('old','injected',{session_id:'s'})
    const row=f.store.enqueue_outbox({session_id:'s',user_id:'u',kind:'assistant',text:'任务完成',client_id:'task-old'})
    await f.outbound.drain()
    assert.equal(sent[0].context_token,'fixture-old')
    assert.equal(f.store.get_outbox(row.outbound_id).status,'sent')
  } finally { f.close() }
})

test('通知拒收不阻塞正常回复；新凭据自动补发，旧凭据不反复重试', async () => {
  const sent=[]
  const f=make_fixture(async input=>{
    if(input.text==='任务完成' && input.context_token!=='fixture-new')
      throw Object.assign(new Error('prepare failed ret=-2'),{rate_limited:true})
    sent.push(input)
  })
  try {
    const row=f.store.enqueue_outbox({session_id:'s',user_id:'u',kind:'assistant',text:'任务完成',client_id:'task-one'})
    await f.outbound.drain()
    assert.equal(f.store.get_outbox(row.outbound_id).status,'failed_terminal')
    assert.match(f.store.get_outbox(row.outbound_id).last_error,/等待新入站凭据/)
    f.store.put_delivery_if_absent({delivery_id:'new',user_id:'u',received_at:Date.now(),context_token:'fixture-new'})
    f.store.update_delivery('new','injected',{session_id:'s'})
    assert.equal(await f.outbound.resume_parked_notices('s','another-user'),0)
    f.store.enqueue_outbox({session_id:'s',user_id:'u',turn:1,kind:'assistant',text:'普通回复',context_token:'fixture-new'})
    assert.equal(await f.outbound.resume_parked_notices('s','u'),1)
    await f.outbound.drain()
    assert.deepEqual(sent.map(item=>item.text),['普通回复','任务完成'])
    assert.equal(f.store.get_outbox(row.outbound_id).status,'sent')
    assert.equal(await f.outbound.resume_parked_notices('s','u'),0)
  } finally {f.close()}
})

test('带凭据的ret=-2先退避，不立即断言会话关闭', async () => {
  const f=make_fixture(async ()=>{throw Object.assign(new Error('ret=-2'),{rate_limited:true})})
  try {
    const row=f.store.enqueue_outbox({session_id:'s',user_id:'u',kind:'assistant',text:'完成',context_token:'fixture'})
    await f.outbound.drain()
    const value=f.store.get_outbox(row.outbound_id)
    assert.equal(value.status,'failed_retryable')
    assert.match(value.last_error,/尚不能判定凭据过期/)
  } finally {f.close()}
})

test('正式任务通知不会被过期清理或待发条数上限删除', () => {
  const f=make_fixture(async()=>{})
  try {
    const row=f.store.enqueue_outbox({session_id:'s',user_id:'u',kind:'assistant',text:'结果',client_id:'task-keep'})
    f.store.mark_outbox_failed(row.outbound_id,'failed_terminal','等待新入站凭据')
    f.store.prune_parked_results(1,Date.now()+86400000)
    assert.ok(f.store.get_outbox(row.outbound_id))
    f.store.enqueue_outbox({session_id:'s',user_id:'u',kind:'assistant',text:'新结果',client_id:'task-keep2'})
    f.store.trim_pending_notices('s',0)
    assert.equal(f.store.parked_results().length,2)
  } finally {f.close()}
})

test('任务入队、等待凭据与送达分开记录，重开数据库仍可追踪', async () => {
  const root=mkdtempSync(join(tmpdir(),'synlove-receipt-'))
  let store=new TaskStore(join(root,'tasks.db')), status='waiting_context', sends=0
  const runtime={store,channels:new Map([['weixin',{
    send:async()=>{sends++;return 's:1'},delivery_status:async()=>({status})}]]),
    assert_owner(){},log_event(){}}
  try {
    const task=store.create_task('s','k',{channel:'weixin'},'测试','coding')
    store.update_task(task.id,{state:'succeeded',notice:'完成',queued:1})
    let tracker=new TaskNoticeTracker(runtime)
    await tracker.refresh_delivery()
    assert.equal(tracker.get_delivery(task.id).status,'waiting_context')
    store.close_store();store=new TaskStore(join(root,'tasks.db'));runtime.store=store
    tracker=new TaskNoticeTracker(runtime);status='sent'
    await tracker.refresh_delivery()
    assert.equal(tracker.get_delivery(task.id).status,'sent')
    assert.equal(sends,1)
    assert.equal(store.get_task(task.id,'s').state,'succeeded')
  } finally {store.close_store();rmSync(root,{recursive:true,force:true})}
})

test('QQ成功回执持久化，缺失记录不会被误判为送达', async () => {
  const root=mkdtempSync(join(tmpdir(),'synlove-qq-receipt-')),path=join(root,'queue.json')
  try {
    let box=new QqOutbox(path,async()=>({ok:true,mode:'active'}),()=>{})
    const id=box.enqueue_reply({text:'完成',target:{userOpenid:'fixture'},dedupeKey:'task-fixture'})
    assert.equal(box.delivery_status(id).status,'pending')
    await box.drain_queue()
    box=new QqOutbox(path,async()=>{throw Error('不得重发')},()=>{})
    assert.equal(box.delivery_status(id).status,'sent')
    assert.equal(box.delivery_status('unknown').status,'missing')
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('漏部署通知提示词时回退现有主人格协议，不阻断结果生成', () => {
  const root=mkdtempSync(join(tmpdir(),'synlove-prompt-fallback-'))
  try {
    mkdirSync(join(root,'prompts'));writeFileSync(join(root,'prompts/PresenterProtocol.md'),'主人格协议')
    const prompt=PresenterEventBridge.prototype.load_notice_prompt.call({runtime:{root,log_event(){}}},'TaskResultNotice.md')
    assert.equal(prompt,'主人格协议')
  } finally {rmSync(root,{recursive:true,force:true})}
})
