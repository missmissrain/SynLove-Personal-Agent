/**
 * 微信消费者单实例 lease + OpenClaw 隔离 preflight。
 *
 * 重构设计文档 §9.2：
 * - lease 必须是**原子**获取（旧的"读文件-查 PID-写文件"存在竞态）；
 * - 获取失败必须让连接器**启动失败**，不能只打印日志继续；
 * - OpenClaw 不得同时拥有同一微信账号，启动前必须 preflight 检查。
 *
 * 本实现用状态库里的 `consumer_lease` 表做主（原子事务）；同时写一个人类可读的标记文件便于运维排查。
 * @module dsh-webhook-weixin/consumer-lease
 */
import type { WeixinStateStore } from '../state/weixinStateStore.ts';
/** 构造参数。 */
export interface ConsumerLeaseOptions {
    /** 状态库。 */
    readonly store: WeixinStateStore;
    /** 账号标识（通常是 bot id），用于提示"谁占着这个账号"。 */
    readonly account_id: string;
    /** 人类可读的锁文件路径（仅诊断用，不参与互斥判定）。 */
    readonly marker_path?: string;
    /** 过期阈值。 */
    readonly stale_ms?: number;
    /** 续租间隔。 */
    readonly heartbeat_ms?: number;
}
/** 原子 lease 的持有者句柄。 */
export declare class ConsumerLease {
    private readonly owner_id;
    private readonly store;
    private readonly account_id;
    private readonly marker_path;
    private readonly stale_ms;
    private readonly heartbeat_ms;
    private timer;
    private released;
    /** 创建持有者（尚未获取）。 */
    constructor(options: ConsumerLeaseOptions);
    /**
     * 尝试获取 lease；失败抛出（调用方必须让连接器启动失败）。
     * @throws 已有活跃消费者时抛出，错误信息包含持有者 pid/账号，便于直接定位。
     */
    acquire(): void;
    /** 是否仍持有 lease（心跳丢失后为 false）。 */
    is_held(): boolean;
    /** 释放 lease；幂等。 */
    release(): void;
    /** 停止续租定时器。 */
    private stop_heartbeat;
    /** 写人类可读标记；仅诊断用途。 */
    private write_marker;
}
/** preflight 结果。 */
export interface PreflightResult {
    readonly ok: boolean;
    readonly problems: readonly string[];
}
/**
 * OpenClaw 隔离 preflight（设计文档 §9.2）。
 *
 * 只做只读检查：OpenClaw 的微信通道若处于启用状态，说明同一账号存在第二个消费者。
 * 检查项：
 * 1. `~/.openclaw/openclaw.json` 的 `plugins.entries.openclaw-weixin.enabled` 必须为 false；
 * 2. 没有正在运行的 OpenClaw gateway 进程持有微信通道。
 *
 * @param openclawConfigPath - 配置文件路径；默认 ~/.openclaw/openclaw.json。
 */
export declare function preflight_openclaw_isolation(openclawConfigPath?: string): PreflightResult;
//# sourceMappingURL=consumerLease.d.ts.map