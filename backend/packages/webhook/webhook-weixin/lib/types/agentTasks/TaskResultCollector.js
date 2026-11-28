import { foldConsumedWork } from '@deepseek-ai/dsh-agent';
import { TaskFailure } from './TaskFailure.js';
export class TaskResultCollector {
    collect_result(agent, boundary = 0, cancelled = false, execution = false, progress = []) {
        const events = agent.session.snapshotEvents().slice(boundary);
        const end = foldConsumedWork(events).end;
        const last = events.filter((event)=>event.type === 'assistant/message' && event.data.turn === end?.data.turn).at(-1);
        const text = last?.data.message?.content?.filter((block)=>block.type === 'text').map((block)=>block.text).join('\n').trim() ?? '';
        const raw = end?.data.reason;
        const reason = typeof raw === 'string' ? raw : raw?.kind;
        const failure = new TaskFailure().from_reason(raw);
        const error = new TaskFailure().describe_error(failure);
        let state = cancelled ? 'cancelled' : reason === 'completed' && text ? 'succeeded' : 'failed';
        if (execution && state === 'succeeded') {
            const declared = text.match(/^\s*TASK_OUTCOME:\s*(succeeded|partial|failed|needs_input)\b/i)?.[1]?.toLowerCase();
            state = declared === 'needs_input' || !declared ? 'partial' : declared;
        }
        const progressText = progress.length ? '\n\n执行中间进度（仅作事实线索，不等同于最终验收）：\n' + progress.slice(-8).map((row)=>`- ${String(row.text ?? '').replace(/\s+/g, ' ').slice(0, 1000)}`).join('\n') : '';
        return {
            state,
            text,
            error,
            failure,
            reason: reason ?? 'missing-terminal-event',
            result: (cancelled ? '已请求停止后台会话；已产生的副作用不会回滚，远程任务是否停止需另行核对。\n' : '') + (error ? `后台执行错误：${error}\n` : '') + (text || '未取得正式最终总结；请结合工具与文件证据核对已完成事项，不能据此判定全部失败或全部成功。') + progressText
        };
    }
}
