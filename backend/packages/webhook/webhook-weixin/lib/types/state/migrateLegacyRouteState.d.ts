/**
 * 旧路由状态（JSON）→ SQLite 的一次性迁移。
 *
 * 重构设计文档 §11 阶段 5：旧文件**只读保留**，迁移失败时禁止从空状态启动。
 * 迁移是幂等的：目标库已有数据时直接跳过，不会重复导入。
 * @module dsh-webhook-weixin/migrate-legacy
 */
import type { WeixinStateStore } from './weixinStateStore.ts';
/** 迁移结果。 */
export interface MigrationResult {
    readonly migrated: boolean;
    readonly reason: string;
    readonly sessions: number;
    readonly deliveries: number;
    readonly cursor: boolean;
}
/**
 * 把旧 JSON 路由状态导入 SQLite。
 *
 * @param store - 目标状态库。
 * @param legacy_path - 旧 JSON 路径；不存在时视为无需迁移。
 * @throws 旧文件存在但损坏/无法解析时抛出（fail closed，禁止静默从空状态启动）。
 */
export declare function migrate_legacy_route_state(store: WeixinStateStore, legacy_path: string): MigrationResult;
//# sourceMappingURL=migrateLegacyRouteState.d.ts.map