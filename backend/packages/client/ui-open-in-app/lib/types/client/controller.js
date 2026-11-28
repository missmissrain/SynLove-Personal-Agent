/** Browser availability/choice state and the launch carrier for the split button. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_OPEN_ROUTE, } from '@deepseek-ai/dsh-host-open-in-app/shared';
/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase() {
    const origin = globalThis.location?.origin;
    return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal';
}
/**
 * Owns the once-per-page availability read, the persisted last choice, and
 * the launch POST. Availability and choice publish through uSES-safe sources
 * so every Session header shares one truth.
 */
export class OpenInAppController {
    fetcher;
    /** Installed app ids in host menu order; null until the host answered. */
    apps = createSnapshotStore(null);
    /** Last chosen app id, or empty before the first choice, shared across sessions and browser restarts. */
    choice = createSnapshotStore('', {
        persist: { name: 'dsh.open-in-app.choice' },
    });
    loading;
    /**
     * @param fetcher - HTTP carrier for the apps read and the launch POST.
     */
    constructor(fetcher = (input, init) => fetch(input, init)) {
        this.fetcher = fetcher;
    }
    /**
     * Read availability once per controller life; concurrent calls share the read.
     * A failed read publishes an empty list, which renders no button at all.
     * @returns after availability is published.
     */
    load() {
        this.loading ??= this.run();
        return this.loading;
    }
    /**
     * Remember one picked app id.
     * @param appId - catalog id from the availability list.
     */
    choose(appId) {
        this.choice.set(appId);
    }
    /**
     * Launch one installed app on a workspace directory.
     * @param appId - catalog id from the availability list.
     * @param path - the session's absolute workspace directory.
     * @returns after the host acknowledged the launch; rejects on any failure.
     */
    async launch(appId, path) {
        const body = { app: appId, path };
        const response = await this.fetcher(new URL(OPEN_IN_APP_OPEN_ROUTE, hostBase()), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok)
            throw new Error(`open failed: HTTP ${String(response.status)}`);
    }
    async run() {
        let apps = [];
        try {
            const response = await this.fetcher(new URL(OPEN_IN_APP_APPS_ROUTE, hostBase()), {
                headers: { accept: 'application/json' },
            });
            if (response.ok) {
                const payload = await response.json();
                if (Array.isArray(payload.apps))
                    apps = payload.apps.filter(id => typeof id === 'string');
            }
        }
        catch {
            // Swallows network failures: an unreachable host reads as no apps, and
            // the header simply shows no button rather than a broken one.
        }
        this.apps.set(apps);
    }
}
//# sourceMappingURL=controller.js.map