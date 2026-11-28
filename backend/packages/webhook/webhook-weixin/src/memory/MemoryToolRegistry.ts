/**
 * 共享记忆工具注册器：以 Agent ctx 为唯一所有者，跨通道幂等注册并在失败时回滚。
 * 参数：ctx 为真实 Agent 作用域，key 为工具组，install 为安装回调；无默认配置。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export class MemoryToolRegistry {
  private static readonly bound = new WeakMap<Context, Set<string>>()

  /** ctx 为作用域，key 为工具组，install 接收受事务保护的注册函数；成功后记录，卸载时移除。 */
  static register_tools(ctx: Context, key: string, install: (register: (tool: ToolDefinition) => void) => void): void {
    const groups = this.bound.get(ctx) ?? new Set<string>()
    if (groups.has(key)) return
    const releases: (() => void)[] = []
    try {
      install(tool => { releases.push(ctx.tools.register(tool)) })
    } catch (error) {
      for (const release of releases.reverse()) release()
      throw error
    }
    groups.add(key)
    this.bound.set(ctx, groups)
    // 真实 Agent ctx 一定提供 effect；最小化工具测试替身可能只实现 tools.register。
    // 在替身环境中没有生命周期钩子时保留注册结果，避免注册本身因测试桩不完整而失败。
    if (typeof (ctx as unknown as { effect?: unknown }).effect === 'function') {
      ctx.effect(() => () => {
        for (const release of releases.reverse()) release()
        groups.delete(key)
      }, `shared-memory.${key}`)
    }
  }
}
