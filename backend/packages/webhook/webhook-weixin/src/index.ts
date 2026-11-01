/**
 * Harness 微信插件入口：iLink 协议、入站/出站协调器、状态存储与生命周期。
 *
 * 重构后的分层（设计文档 §3.1）：
 *   transport/    只拉取与规范化
 *   coordination/ 入站幂等路由 + 出站 durable outbox
 *   state/        SQLite 唯一状态源（delivery/outbox/route/cursor/turn_context/lease）
 *   lifecycle/    原子 lease 与 OpenClaw 隔离
 *   reply/        仅文本聚合（无发送语义）
 *   session/      Agent 单一所有权宿主
 */

export * from './api/ilinkTypes.ts'
export * from './api/ilinkClient.ts'
export * from './media/mediaCrypto.ts'
export * from './media/mediaTranscoder.ts'
export * from './message/messageNormalizer.ts'
export * from './diagnostics/probe.ts'
export * from './types/domain.ts'
export * from './state/weixinStateStore.ts'
export * from './state/turnContextStore.ts'
export * from './state/migrateLegacyRouteState.ts'
export * from './transport/weixinIngress.ts'
export * from './coordination/inboundCoordinator.ts'
export * from './coordination/outboundCoordinator.ts'
export * from './lifecycle/consumerLease.ts'
export * from './reply/replyAggregator.ts'
export * from './session/weixinSessionHost.ts'
export * from './runtime/weixinConnector.ts'
export * from './plugin.ts'
export * from './memory/timelineTypes.ts'
export * from './memory/timelineStore.ts'
export * from './memory/timelineTools.ts'
export * from './memory/graphTypes.ts'
export * from './memory/graphStore.ts'
export * from './memory/graphTools.ts'
export * from './memory/memoryRemoteClient.ts'
export * from './memory/sharedMemory.ts'
