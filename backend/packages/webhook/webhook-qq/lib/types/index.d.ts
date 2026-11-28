/**
 * QQ 官方机器人通道（Cordis 函数式插件）——**与微信通道并存**，互不影响。
 *
 * 做什么：
 * - 用官方 WebSocket 网关收 `C2C_MESSAGE_CREATE`（单聊）/`GROUP_AT_MESSAGE_CREATE`（群 @）；
 * - 复用微信那边的 `HarnessSessionHost`（**不改微信包**）：`qq-<openid>` 一个会话，
 *   同一套 Agent / 工具 / 记忆 / 人格；
 * - 一轮结束后把回复**带回 QQ**：优先"被动回复"（带 msg_id，单聊 60 分钟内最多 4 次），
 *   失败自动退回"主动推送"（不受 5 分钟窗口限制，受频控）。
 *
 * 为什么不复用微信的协调器：那套围绕 iLink 的 delivery/outbox/lease 设计（含发送窗口停放），
 * QQ 是官方接口、窗口宽松，硬套反而要改微信代码。这里只借"会话宿主"，其余保持独立 ——
 * 这就是"最小修改"。
 *
 * @module dsh-webhook-qq
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis function-plugin 名称。 */
export declare const name = "webhook-qq";
/** 依赖的 Harness 原生服务（缺任一则插件不激活，而不是等第一条消息才炸）。 */
export declare const inject: string[];
/** 通道配置：AppID/AppSecret 由启动器从 config/secrets.json 注入环境变量。 */
export interface Config {
    /** 机器人 AppID（开放平台管理端） */
    app_id: string;
    /** 机器人 AppSecret（机密，建议走环境变量） */
    client_secret: string;
    /** Agent 工作目录 */
    workspace_path: string;
    /** 模型 provider */
    provider: string;
    /** 模型 id */
    model: string;
    /** Agent 预设（挂哪些工具/人格） */
    agent_preset?: string;
    /** 接口基址 */
    base_url?: string;
    /** 订阅 intents 位图（默认 1<<25 群@+单聊） */
    intents?: number;
}
/** Schemastery 配置定义。 */
export declare const Config: z<Config>;
/** 注册 QQ 通道（生命周期跟随 Cordis effect）。 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map