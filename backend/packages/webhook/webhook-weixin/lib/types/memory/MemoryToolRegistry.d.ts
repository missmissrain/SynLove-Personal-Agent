/**
 * 共享记忆工具注册器：以 Agent ctx 为唯一所有者，跨通道幂等注册并在失败时回滚。
 * 参数：ctx 为真实 Agent 作用域，key 为工具组，install 为安装回调；无默认配置。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare class MemoryToolRegistry {
    private static readonly bound;
    /** ctx 为作用域，key 为工具组，install 接收受事务保护的注册函数；成功后记录，卸载时移除。 */
    static register_tools(ctx: Context, key: string, install: (register: (tool: ToolDefinition) => void) => void): void;
}
//# sourceMappingURL=MemoryToolRegistry.d.ts.map