export class MemoryToolRegistry {
    static bound = new WeakMap();
    static register_tools(ctx, key, install) {
        const groups = this.bound.get(ctx) ?? new Set();
        if (groups.has(key)) return;
        const releases = [];
        try {
            install((tool)=>{
                releases.push(ctx.tools.register(tool));
            });
        } catch (error) {
            for (const release of releases.reverse())release();
            throw error;
        }
        groups.add(key);
        this.bound.set(ctx, groups);
        if (typeof ctx.effect === 'function') {
            ctx.effect(()=>()=>{
                    for (const release of releases.reverse())release();
                    groups.delete(key);
                }, `shared-memory.${key}`);
        }
    }
}
