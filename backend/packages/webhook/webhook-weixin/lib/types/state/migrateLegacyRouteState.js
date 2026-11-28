import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { probe } from '../diagnostics/probe.js';
export function migrate_legacy_route_state(store, legacy_path) {
    if (!existsSync(legacy_path)) {
        return {
            migrated: false,
            reason: 'legacy_absent',
            sessions: 0,
            deliveries: 0,
            cursor: false
        };
    }
    const existing = store.route_summary();
    if (existing.users > 0 || store.get_cursor().length > 0) {
        probe('state', 'migrate.skip', {
            reason: 'target_not_empty',
            users: existing.users
        });
        return {
            migrated: false,
            reason: 'target_not_empty',
            sessions: 0,
            deliveries: 0,
            cursor: false
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(legacy_path, 'utf8'));
    } catch (error) {
        probe('state', 'migrate.failed', {
            error: String(error)
        });
        throw new Error(`旧路由状态无法解析，拒绝从空状态启动（fail closed）：${legacy_path} —— ` + `${error instanceof Error ? error.message : String(error)}`);
    }
    const snapshot = `${legacy_path}.migrated-${Date.now()}`;
    try {
        copyFileSync(legacy_path, snapshot);
    } catch (error) {
        probe('state', 'migrate.snapshot_failed', {
            error: String(error)
        });
    }
    const sessions = Object.entries(parsed.sessions ?? {});
    const deliveries = parsed.deliveries ?? [];
    store.transaction(()=>{
        for (const [user_id, session_id] of sessions)store.set_session_id(user_id, session_id);
        for (const delivery_id of deliveries){
            const user_id = sessions.find(([, sid])=>sid !== undefined)?.[0] ?? 'legacy';
            if (store.put_delivery_if_absent({
                delivery_id,
                user_id,
                received_at: Date.now()
            })) {
                store.update_delivery(delivery_id, 'injected', {
                    injected_at: Date.now(),
                    session_id: user_id
                });
            }
        }
        if (parsed.cursor) store.set_cursor(parsed.cursor);
    });
    const result = {
        migrated: true,
        reason: 'migrated',
        sessions: sessions.length,
        deliveries: deliveries.length,
        cursor: Boolean(parsed.cursor)
    };
    probe('state', 'migrate.done', {
        ...result
    });
    console.error(`[webhook-weixin] 已迁移旧路由状态：路由 ${result.sessions} 条、去重 ${result.deliveries} 条、` + `游标 ${result.cursor ? '有' : '无'}；旧文件保留在 ${legacy_path}`);
    return result;
}
