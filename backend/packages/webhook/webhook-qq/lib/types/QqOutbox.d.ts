import type { QqSendResult, QqSendTarget } from './send.ts';
export interface QqReply {
    id: string;
    target: QqSendTarget;
    text: string;
    msgId?: string;
    attempt: number;
    next_at: number;
    status: 'pending' | 'failed_terminal';
    sent_parts: number[];
    error?: string;
}
export declare class QqOutbox {
    private readonly path;
    private readonly send;
    private readonly report;
    private rows;
    private draining;
    private stopped;
    /** path 为队列文件，send 接收消息与分段确认回调，report 只报告脱敏元数据。 */
    constructor(path: string, send: (row: QqReply, mark: (index: number) => void) => Promise<QqSendResult>, report: (state: Record<string, unknown>) => void);
    /** 无参数；写入临时文件后原子替换，私聊正文只保存在本地状态目录。 */
    private save_rows;
    /** reply 为完整待发回复；持久化失败会抛出，调用方不得删除内存回复。 */
    enqueue_reply(reply: {
        text: string;
        target: QqSendTarget;
        msgId?: string;
    }): string;
    /** 无参数；串行发送到期消息，失败保留，防止相同目标后续消息越过失败记录。 */
    drain_queue(): Promise<void>;
    /** 无参数；停止取新任务，已经在途的发送仍可持久记录结果。 */
    stop_queue(): void;
}
//# sourceMappingURL=QqOutbox.d.ts.map