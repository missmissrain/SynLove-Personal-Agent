/**
 * 微信连接器：把传输层、入站协调器、出站协调器与生命周期装配到一起。
 *
 * 重构后的职责边界（设计文档 §3.1）：
 *   WeixinIngress       只拉取/规范化
 *   InboundCoordinator  幂等、路由、控制、投递、恢复
 *   OutboundCoordinator 唯一发送队列（含心跳与恢复）
 *   本文件              只做装配、生命周期与 assistant-stream 桥接
 *
 * 本文件**不再**维护：delivery 去重、user→session 路由、回复缓冲、发送队列、per-session 心跳。
 * @module dsh-webhook-weixin/connector
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IlinkClientOptions } from '../api/ilinkTypes.ts';
/** 连接器配置。 */
export interface WeixinConnectorOptions extends IlinkClientOptions {
    /** SQLite 状态库路径；默认落在状态文件同目录。 */
    readonly state_db?: string;
    /** preset id。 */
    readonly agent_preset?: string;
    /** 工作目录。 */
    readonly workspace_path?: string;
    /** 模型 provider / model（记录进 Session 元数据，并传给 Agent 解析提示变量）。 */
    readonly provider?: string;
    readonly model?: string;
    /** 推理强度（可选）。 */
    readonly reasoning_effort?: string;
    /** lease 标记文件（诊断用）。 */
    readonly lease_marker?: string;
    /** 是否检查 OpenClaw 隔离；默认 true。 */
    readonly enforce_openclaw_isolation?: boolean;
    /** 旧版路由状态文件路径（仅用于一次性迁移；迁移后只读保留）。 */
    readonly state_file?: string;
    /** `/codex` 远程任务的工作目录；默认 SynLove。 */
    readonly codex_workspace?: string;
    /** 长期记忆（时间线）根目录；默认 ~/.dsh/timeline。 */
    readonly timeline_dir?: string;
    /** 知识图谱（社交网络）根目录；默认 ~/.dsh/graph。 */
    readonly graph_dir?: string;
}
/** 微信连接器：装配 + 生命周期。 */
export declare class WeixinConnector {
    private readonly store;
    private readonly turn_context;
    private readonly ingress;
    private readonly inbound;
    private readonly outbound;
    private readonly host;
    private readonly lease;
    private readonly client;
    /** Codex 远程桥（`/codex` 指令）。 */
    private readonly codex_bridge;
    /** Codex 任务完成监视器：任务一结束就主动推微信。 */
    private readonly codex_watcher;
    /** opencode 远程桥（`/opencode` 指令）。 */
    private readonly opencode_bridge;
    /** opencode 完成监视器：只汇报外部发起的任务。 */
    private readonly opencode_watcher;
    private readonly controller;
    private readonly stream_disposers;
    private readonly stream_agents;
    private readonly observation_disposers;
    /** 每个 Stream 的工具调用计数（用于"每 N 次工具调用推一次摘要"）。 */
    private readonly tool_calls_seen;
    /**
     * 每个 Session 当前所在的 turn。
     * 只有 `start` 帧带 `turn`；`chunk`/`end` 帧不带，因此必须记住最近一次的 turn，
     * 否则 turn context 会全部绑到 0（绑定/查询错位）。
     */
    private readonly current_turn;
    /**
     * 待定的"这一轮失败了"收尾定时器（agent 报错后等宽限期，没有恢复就收尾）。
     * 没有它的话，模型持续报错时这一轮会永远停在"处理中"。
     */
    private readonly turn_failure_timers;
    /** 当前在用的模型（故障转移会改它；初值来自配置）。 */
    private current_model;
    /** 模型健康表：失活的 API 在冷却期内不再被选。 */
    private readonly model_health;
    /** 每个会话最近一条用户消息（换模型后要重做它）。 */
    private readonly last_user_message;
    /** 本轮是否报过错（用于"整轮失败却一个字都没发"时补一条说明）。 */
    private readonly turn_error;
    /** 本轮有没有成功发出过正文。 */
    private readonly turn_visible;
    /**
     * 正在压缩上下文的会话（`session_id`）。
     *
     * 压缩要读完整段历史（实测 1–3 分钟），这期间**不应该再往会话里塞新消息**：
     * 否则新消息会和压缩抢同一个会话、甚至被压缩吞掉。做法是期间的新消息只入库不投递
     * （`handle_batch(..., { hold: true })`），压缩结束后由恢复流程统一重投。
     */
    private readonly compacting_sessions;
    /** 压缩期间已经回过"稍后回复"的会话（同一个压缩窗口只回一次，别刷屏）。 */
    private readonly compact_ack_sent;
    /** 每个 Session 上次推送思考摘要的时间（进度节流）。 */
    private readonly last_progress_at;
    private readonly aggregators;
    private running;
    private stopped;
    /** 本机调试注入口（仅当设置 DSH_WEIXIN_INJECT_PORT 时启用）。 */
    private inject_server;
    /** 长期记忆（时间线）；DSH_TIMELINE_ENABLED=0 可整体关闭。 */
    private readonly timeline;
    /** 知识图谱（社交网络）：人物 + "谁称呼谁为什么"的有向边。 */
    private readonly graph;
    /** 会话工作目录（会话落盘路径由它推导，必须与 HarnessSessionHost 一致）。 */
    private readonly workspace_path;
    /** 通知开关：codex / opencode 的完成汇报是否推送。 */
    private readonly notify;
    /** 摘要调度器（低频、纯本地检查；与 iLink 轮询无关）。 */
    private timeline_scheduler;
    /** 知识图谱的空闲增量更新调度器。 */
    private graph_scheduler;
    /**
     * 记忆更新的模型客户端：本地 Gemma 或云端模型（由 `DSH_MEMORY_ENGINE` 决定）。
     *
     * 本地免费但要占约 5.3GB 显存；云端不占显存但花额度。用户可在控制台切换。
     */
    private readonly memory;
    /**
     * 后台任务的闸门（摘要 / 图谱 / 图片描述共用）。
     *
     * 本地引擎：并发 1 + **等显存空闲再启动**（用户可能在跑游戏/训练）；
     * 云端引擎：不等显存（本来就不占），但同样限制并发，避免把额度打爆。
     */
    private readonly gemma;
    /** 组装全部组件；构造期不做 IO 失败判定。 */
    /** 宿主 ctx（故障转移要经它取 sessionController）。 */
    private readonly ctx;
    constructor(ctx: Context, options: WeixinConnectorOptions);
    /**
     * 启动：preflight → 装配检查 → lease → 恢复 → 开轮询。
     * 任一步失败都抛出，让上层把"微信消费者未启动"如实暴露出来（禁止假成功）。
     */
    start(): Promise<void>;
    /** 真正的启动序列。 */
    private run;
    /**
     * 启动本机注入口（开发设施，默认关闭）。
     *
     * 用途：把一条"用户消息"塞进真实入站管线（delivery → 协调器 → agent → outbox → 微信），
     * 这样测试时不必每次都用真手机发微信。只绑 127.0.0.1，且只有设置端口才启用。
     */
    private start_inject_server_if_configured;
    /**
     * 管理动作分发（控制台按钮走这里）。
     *
     * 之所以由本进程执行而不是让控制台直接删文件：时间线/图谱有内存缓存、
     * 会话上下文还被 agent 句柄持有——只有持有者才知道该怎么正确清。
     */
    private admin_action;
    /**
     * 清空长期记忆。
     *
     * - `timeline`：删掉时间线目录内容，并清掉存储层的内存缓存（否则还会列出已删的天）；
     * - `graph`：删掉图谱目录内容 → **重建中心**（欣爱 + 主人，否则查询会说"图谱里没有人"）
     *   → 水位归零（让图谱从现有历史里重新长出来）。
     *
     * 与"清空上下文"是两件事：这里清的是"她长期记得什么"，上下文是"这次聊天记得什么"。
     */
    private clear_memory;
    /**
     * 三类记忆的体量（控制台展示用）。
     *
     * 上下文的体量按**落盘会话文件**算（用户 id → 会话 id → 会话目录），
     * 所以它显示的是真实占用，而不是一个估计值。
     */
    private memory_stats;
    /**
     * 清空对话上下文（控制台「清空上下文」按钮调这里）。
     *
     * 四步，顺序不能换：
     * 1. **dispose agent**：只有 owner 释放才会关掉会话日志的写句柄。
     *    若跳过这步直接删文件，残留句柄下次 append 会写出"没有 header 的坏文件"——
     *    那个会话以后再也恢复不起来（这是实测踩过的坑）。
     * 2. 丢掉该会话的内存残留（stream/turn/聚合器）。
     * 3. **尽力删除旧会话文件**：回收磁盘；删不掉也不影响结果（见第 4 步）。
     * 4. **清路由 + 代次 +1**：下一条消息因此拿到一个新会话 id → 必然是空上下文。
     *
     * 长期记忆（时间线/图谱）**不动**：上下文是"这次聊天记得什么"，
     * 长期记忆是"她这个人记得什么"，两者是分开的，各有各的清空入口。
     */
    private clear_context;
    /**
     * 重新解析 preset（GUI 挂载/卸载工具后调用），并**真的验证一次**。
     *
     * 为什么要在本进程做：preset 组合是宿主实例记忆的，必须由持有它的进程重置。
     * 验证方式是用一个探针会话真创建一次 Agent —— preset 里挂了个缺依赖的插件时，
     * 失败会在这里暴露（而不是等到用户下一条消息才发现 bot 不回话了），
     * 验证完立刻释放并删掉探针会话文件，不留痕迹。
     */
    private reload_preset;
    /** 丢掉某个会话在内存里的残留状态（上下文已经清掉，这些映射不能再留着）。 */
    private forget_session;
    /** 注入一条测试消息：复用真实入站管线，但不提交 iLink 游标（它本来就不是 iLink 来的）。 */
    private inject_test_message;
    /**
     * 把消息里的媒体记进长期记忆。
     *
     * 分两步，且都**不阻塞**用户这条消息的处理：
     * 1. 解析出附件引用（原图由 harness 附件服务按内容寻址存好，天然去重），
     *    把引用挂到当天那条记录上——**不复制文件**，所以"存原图"几乎零成本；
     * 2. 后台让视觉模型（Gemma + mmproj）写一句描述，回填到引用上——
     *    描述让"发了什么图"变成可检索文本，并会随当天摘要一起被总结。
     *
     * 原图永远是权威：描述错了、模型不在线，都不影响原始事实已经存下来了。
     */
    private record_media_to_timeline;
    /** 让视觉模型给一张图写一句描述并回填；全程 best-effort。 */
    private describe_image;
    /** 写一条长期记忆；失败只留痕，绝不影响消息收发。 */
    private record_timeline;
    /**
     * 启动时间线摘要调度（低频、纯本地）。
     *
     * 刻意与 iLink 轮询解耦：这里只读本地文件，不发任何微信请求；
     * 触发条件是"某日已空闲 ≥3 小时"，所以 5 分钟看一次足够，也不会给微信链路添压力。
     */
    private start_timeline_scheduler_if_enabled;
    /**
     * 确保本地 Gemma 服务在跑（运行期按需补拉）。
     *
     * 启动时如果显存被占用，启动器会跳过拉起；等显存空出来之后由这里补拉，
     * 路径/端口都从启动器注入的环境变量读取（**不在这里重新猜路径**，避免两处不一致）。
     */
    private ensure_gemma_running;
    /** 轮询主循环：批次完成后才提交 cursor；错误按类别处理。 */
    private poll_loop;
    /** 写认证失效标记，供启动器提示扫码。 */
    private write_auth_marker;
    /** 桥接 assistant-stream：聚合成正文、按 turn 绑定上下文、驱动进度/心跳。 */
    private bind_agent_stream;
    /**
     * 补跑"被重启打断的轮次"。
     *
     * 做法：启动时扫描 `inflight_turn:*` 残留标记（轮次开始写、结束删），把对应 delivery
     * 从 injected 退回 received —— 随后 `inbound.recover_unfinished()` 会把它重新注入，
     * 用户就能拿到这一轮的回复，而不是被静默丢掉。
     *
     * @returns 补跑的轮次数
     */
    private rescue_interrupted_turns;
    /**
     * 入站批次的统一入口（轮询与调试注入口都走这里）。
     *
     * **压缩上下文期间不收新消息**：只入库（payload 已落库）+ 回一句"稍后回复"，
     * 游标故意不提交；压缩结束后 `recover_unfinished()` 会把它们重投。
     * 这样新消息既不会打断/污染压缩，也不会丢。
     *
     * @param messages - 本批入站消息
     * @param cursor - 平台游标（注入口没有）
     * @returns 是否允许提交该批次 cursor
     */
    private handle_inbound;
    /**
     * 压缩上下文期间收到消息：回一句"正在压缩上下文，稍后回复"（同一个窗口只回一次）。
     * 消息本身已经入库，压缩结束后会补处理。
     */
    private notify_compacting;
    /**
     * 取消后的收尾（幂等）。
     *
     * `agent.cancel()` 走 abort 路径时**不会**触发 `agent/turn-stopping`（实测），
     * 所以这里把 handle_turn_end 里那些"必须做"的清理补上：
     * 停心跳（否则每 5 分钟继续发「还在处理中」）、删 inflight 标记（否则下次启动会重跑已取消的任务）、
     * 清错误/可见性/聚合器/当前轮次状态。
     */
    private finalize_turn;
    /**
     * 一轮开始：**只在首次进入该 turn 时**绑定回复上下文并启动进度追踪。
     *
     * 关键约束（修复"同一 turn 上下文被后续消息覆盖"）：
     * 已经绑定过的 turn 绝不重绑——长任务期间用户再发消息时，
     * 那条新消息属于下一个 turn，不能改写本轮回复该用的 context_token。
     */
    private begin_turn_once;
    /**
     * 该 turn 绑定是否仍然新鲜。
     * 超过 TTL 就视为"重启前的旧绑定"：turn 号会重复，但 context_token 可能已失效。
     */
    private binding_is_fresh;
    /**
     * 自动换模型：把失活的 API 拉黑，切到下一个可用的，并把用户刚才那条消息重做一遍。
     *
     * 全过程不重启、不丢上下文（`sessionController.selectModel` 装到下一个请求上），
     * 并同步写回 `modelConfig.json` 的默认模型——否则控制台显示的、以及下次启动器同步出去的
     * 还是那个已经挂掉的模型，等于白换。
     */
    private failover_model;
    /** 把新的默认模型写回 modelConfig.json（含备份）。 */
    private persist_default_model;
    /** 记住最近一条用户消息（换模型后要重做它）。 */
    private remember_user_message;
    /**
     * 重做最近一条用户消息（每个会话只自动重做一次，避免连环重试）。
     *
     * 走的是**真实入站管线**（和用户自己发一样），所以工具、记忆、回复都一样；
     * 只是 delivery id 用 `retry-` 前缀，便于在探针里区分。
     */
    private retry_last_message;
    /**
     * 记一次 agent 错误，并在宽限期后把这一轮按失败收尾。
     *
     * 为什么必须做：模型接口持续报错（例如 429「api key 日限额已用完」）时，agent loop
     * 会一直重试/卡住，`agent/turn-stopping` 永远不来——用户那边只看到每 5 分钟一条
     * "还在处理中"，永远等不到结果（2026-09-21 23:46 那轮实测卡了 10 分钟以上）。
     * 宽限期内只要有任何新分片就取消收尾（说明重试成功了，别抢话）。
     */
    private arm_turn_failure;
    /** 有活动就取消待定的失败收尾。 */
    private clear_turn_failure;
    /**
     * 把模型接口的报错翻成"人话 + 该怎么办"。
     *
     * 为什么必须分类：以前**所有**失败都写"多半是额度/限额用完或 key 失效"，而实测
     * 最常见的其实是传输层失败（OpenAI SDK 的 `APIConnectionError`，消息就是
     * "Connection error."——接口那一小段时间连不上/连接被断开），跟额度完全无关。
     * 说错原因会让用户白等额度、或者去换根本不坏的 key。
     */
    private explain_llm_failure;
    /**
     * 把卡住的一轮按失败收尾：**如实说明原因**，并把这一轮关掉。
     *
     * 宁可说"没做成 + 为什么"，也不要让用户对着"还在处理中"干等——
     * 这也是人格里"工具失败就直接说失败和可确认的原因"的要求。
     */
    private fail_turn;
    /** 一轮结束：补发尾段、清理状态。 */
    private handle_turn_end;
    /** 处理流分片：正文聚合发送、思考摘要作为进度（即心跳）。 */
    private handle_chunk;
    /**
     * 按时间推送思考摘要（即进度，也是心跳）。
     *
     * 触发条件：距上次推送 ≥ PROGRESS_MIN_INTERVAL_MS，且有足够长度的新摘要。
     * 不再依赖工具调用次数——否则"只调一次工具"的任务全程无进度。
     */
    private maybe_push_progress;
    /** 停止：幂等；释放监听、租约与 Agent。 */
    stop(): Promise<void>;
}
/**
 * 将连接器绑定到 Cordis effect；卸载时幂等地停止。
 *
 * 关键：`start()` 必须被 **await**，让 lease 冲突 / OpenClaw 隔离失败 / Agent 能力缺失 /
 * 微信启动失败都变成插件装配失败（fail closed）。否则会退化成"Web 后台正常、微信消费者
 * 其实没起来"的假成功——此时进程还活着，但用户发消息永远没人接。
 */
export declare function install_weixin_connector(ctx: Context, options: WeixinConnectorOptions): WeixinConnector;
//# sourceMappingURL=weixinConnector.d.ts.map