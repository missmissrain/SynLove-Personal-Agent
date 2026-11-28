/**
 * 微信链路诊断探针：把入站/状态/出站三个状态机的关键跃迁写成结构化 JSONL，
 * 便于事后回答"这条消息走到哪一步、卡在哪、为什么没回复"。
 *
 * 与 llm 探针（DSH_LLM_PROBE_LOG）分工：
 * - llm 探针：模型请求与原始流事件；
 * - 本探针：微信协议、状态机、outbox、lease。
 *
 * 仅在设置 `DSH_WEIXIN_PROBE_LOG`（文件路径）时生效；探针写入失败绝不影响主流程。
 * @module dsh-webhook-weixin/probe
 */
/** 探针是否启用。 */
export declare function probe_enabled(): boolean;
/**
 * 追加一条探针记录。
 * @param scope - 子系统名：ingress / state / inbound / outbound / lifecycle / turn-context。
 * @param event - 事件名，如 delivery.received / outbox.sent。
 * @param fields - 结构化字段；值会被安全序列化并截断。
 */
export declare function probe(scope: string, event: string, fields?: Record<string, unknown>): void;
/** 计时器：`const done = probe_timer('scope','event',{...}); ... done({extra})`。 */
export declare function probe_timer(scope: string, event: string, fields?: Record<string, unknown>): (extra?: Record<string, unknown>) => void;
//# sourceMappingURL=probe.d.ts.map