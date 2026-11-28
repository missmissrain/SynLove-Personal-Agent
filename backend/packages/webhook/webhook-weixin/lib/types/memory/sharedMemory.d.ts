/**
 * 进程内共享的长期记忆套件（时间线 + 图谱）。
 *
 * 背景：记忆引擎（timeline/graph）只在微信连接器里实例化。QQ 通道也要
 * 落档和读图，但又不能各起一套 store（会双写同一目录）。所以由微信连接器
 * 在构造完成后 `set_shared_memory` 注册一份，QQ 通道用 `get_shared_memory`
 * 取同一实例：QQ 只负责「写记录」和「读查询工具」，摘要/图谱更新仍由
 * 微信连接器里的调度器统一做。
 *
 * @module dsh-webhook-weixin/shared-memory
 */
import type { TimelineStore } from './timelineStore.ts';
import type { KnowledgeGraphStore } from './graphStore.ts';
/** 共享给其它通道的记忆套件。 */
export interface SharedMemorySuite {
    readonly timeline: TimelineStore;
    readonly graph: KnowledgeGraphStore;
}
/** 微信连接器构造完成后注册（幂等，后写覆盖）。 */
export declare function set_shared_memory(next: SharedMemorySuite): void;
/** 取当前共享套件；微信连接器尚未就绪时为 undefined。 */
export declare function get_shared_memory(): SharedMemorySuite | undefined;
//# sourceMappingURL=sharedMemory.d.ts.map