/**
 * Bind the listing to one Remote face, keeping only what the tree stores.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing the tree's face performs.
 */
export function createList(remote) {
    return async (sessionId, path, signal) => {
        const result = await remote.workspaceFiles.list(sessionId, path, signal);
        if (!result.ok)
            return result;
        return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } };
    };
}
/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent, name) {
    return `${parent.replace(/[/\\]+$/, '')}/${name}`;
}
/**
 * Bind the tree's face to one directory listing.
 * @param list - the bound `workspaceFiles.list` call.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(list) {
    return (sessionId, actions) => {
        /** Per tab, per absolute path: the listing generation a settlement must match; the latest request wins. */
        const generations = new Map();
        const nextGeneration = (tabId, path) => {
            const byPath = generations.get(tabId) ?? new Map();
            generations.set(tabId, byPath);
            const generation = (byPath.get(path) ?? 0) + 1;
            byPath.set(path, generation);
            return generation;
        };
        const load = (tabId, path, signal) => {
            if (signal.aborted)
                return;
            const generation = nextGeneration(tabId, path);
            actions.loading(tabId, path);
            void list(sessionId, path, signal).then((result) => {
                // A newer listing of this level was asked for since, or the record is
                // gone and its bookkeeping with it: nothing left for this one to write.
                if (generations.get(tabId)?.get(path) !== generation)
                    return;
                if (result.ok)
                    actions.loaded(tabId, path, result.value);
                else
                    actions.failed(tabId, path, result.error);
            });
        };
        return {
            start(tabId, root, signal) {
                actions.start(tabId, root);
                signal.addEventListener('abort', () => {
                    generations.delete(tabId);
                    actions.forget(tabId);
                }, { once: true });
                load(tabId, root, signal);
            },
            load,
            toggle(tabId, path, loaded, signal) {
                actions.toggled(tabId, path);
                if (!loaded)
                    load(tabId, path, signal);
            },
        };
    };
}
//# sourceMappingURL=face.js.map