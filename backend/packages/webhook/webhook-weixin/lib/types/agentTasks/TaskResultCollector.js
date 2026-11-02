import { foldConsumedWork } from '@deepseek-ai/dsh-agent';
export class TaskResultCollector {
    collect_result(agent, boundary = 0, cancelled = false, execution = false) {
        const events = agent.session.snapshotEvents().slice(boundary);
        const end = foldConsumedWork(events).end;
        const last = events.filter((event)=>event.type === 'assistant/message' && event.data.turn === end?.data.turn).at(-1);
        const text = last?.data.message?.content?.filter((block)=>block.type === 'text').map((block)=>block.text).join('\n').trim() ?? '';
        const raw = end?.data.reason;
        const reason = typeof raw === 'string' ? raw : raw?.kind;
        let state = cancelled ? 'cancelled' : reason === 'completed' && text ? 'succeeded' : 'failed';
        if (execution && state === 'succeeded') {
            const declared = text.match(/^\s*TASK_OUTCOME:\s*(succeeded|partial|failed|needs_input)\b/i)?.[1]?.toLowerCase();
            state = declared === 'needs_input' || !declared ? 'partial' : declared;
        }
        return {
            state,
            text,
            reason: reason ?? 'missing-terminal-event',
            result: (cancelled ? '已请求停止后台会话；已产生的副作用不会回滚，远程任务是否停止需另行核对。\n' : '') + (text || '未取得正式最终总结；本次执行没有可验证的成功结果。')
        };
    }
}
