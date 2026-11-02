/**
 * 任务结果收集：只采用正式助手最终正文，并结合 Harness 真实终态判断执行是否异常。
 * 参数为 Agent 和起始事件偏移；不采集内部推理，不把外部工具一句“完成”当验证。
 */
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'

export class TaskResultCollector {
  /** agent 为执行/主人格 Agent，boundary 为本次执行起点；cancelled 表示真实取消请求。 */
  collect_result(agent: any, boundary = 0, cancelled = false, execution = false): any {
    const events = agent.session.snapshotEvents().slice(boundary)
    const end = foldConsumedWork(events).end
    const last = events.filter((event: any) => event.type === 'assistant/message'
      && event.data.turn === end?.data.turn).at(-1)
    const text = last?.data.message?.content?.filter((block: any) => block.type === 'text')
      .map((block: any) => block.text).join('\n').trim() ?? ''
    const raw = end?.data.reason
    const reason = typeof raw === 'string' ? raw : raw?.kind
    // succeeded 仅表示执行轮次正常结束；目标是否完成由保留的执行总结说明。
    let state = cancelled ? 'cancelled' : reason === 'completed' && text ? 'succeeded' : 'failed'
    if (execution && state === 'succeeded') {
      const declared = text.match(/^\s*TASK_OUTCOME:\s*(succeeded|partial|failed|needs_input)\b/i)?.[1]?.toLowerCase()
      state = declared === 'needs_input' || !declared ? 'partial' : declared
    }
    return { state, text, reason: reason ?? 'missing-terminal-event',
      result: (cancelled ? '已请求停止后台会话；已产生的副作用不会回滚，远程任务是否停止需另行核对。\n' : '')
        + (text || '未取得正式最终总结；本次执行没有可验证的成功结果。') }
  }
}
