function meta_key(target) {
    return `notify.${target}`;
}
export function create_notify_settings(store) {
    return {
        is_enabled (target) {
            return store.get_meta(meta_key(target)) !== '0';
        },
        set_enabled (target, enabled) {
            store.set_meta(meta_key(target), enabled ? '1' : '0');
        },
        snapshot () {
            return {
                codex: store.get_meta(meta_key('codex')) !== '0',
                opencode: store.get_meta(meta_key('opencode')) !== '0'
            };
        },
        async is_enabled_async (target) {
            return await store.get_meta(meta_key(target)) !== '0';
        },
        async set_enabled_async (target, enabled) {
            await store.set_meta(meta_key(target), enabled ? '1' : '0');
        },
        async snapshot_async () {
            const [codex, opencode] = await Promise.all([
                store.get_meta(meta_key('codex')),
                store.get_meta(meta_key('opencode'))
            ]);
            return {
                codex: codex !== '0',
                opencode: opencode !== '0'
            };
        }
    };
}
