export class MemoryToolRegistry {
    static bound = new WeakMap();
    /** ctx 为作用域，key 为工具组，install 接收受事务保护的注册函数；成功后记录，卸载时移除。 */
    static register_tools(ctx, key, install) {
        const groups = this.bound.get(ctx) ?? new Set();
        if (groups.has(key))
            return;
        const releases = [];
        try {
            install(tool => { releases.push(ctx.tools.register(tool)); });
        }
        catch (error) {
            for (const release of releases.reverse())
                release();
            throw error;
        }
        groups.add(key);
        this.bound.set(ctx, groups);
        // 真实 Agent ctx 一定提供 effect；最小化工具测试替身可能只实现 tools.register。
        // 在替身环境中没有生命周期钩子时保留注册结果，避免注册本身因测试桩不完整而失败。
        if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => {
                for (const release of releases.reverse())
                    release();
                groups.delete(key);
            }, `shared-memory.${key}`);
        }
    }
}
//# sourceMappingURL=MemoryToolRegistry.js.map