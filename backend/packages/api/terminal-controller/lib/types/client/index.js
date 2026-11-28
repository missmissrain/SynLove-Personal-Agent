/** Client terminal model service; views are keyed independently from Host terminal identities. */
import { Service } from '@deepseek-ai/cordis';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { TerminalView } from "./model.js";
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { randomUUID } from '@deepseek-ai/dsh-util-crypto';
import { preferredShell, rememberShell } from "./shell-preference.js";
import { TerminalCloseRequests } from "./close-requests.js";
/** Session and occurrence lookup, independent tab and terminal identities and background cleanup. */
export class ClientTerminals extends Service {
    remote;
    /** Failed cleanup tasks; successful and in-progress closes have no visible notification. */
    closeFailures = createSnapshotStore([]);
    requests = new TerminalCloseRequests();
    closing = new Map();
    closed = new Set(this.requests.pending().map(request => request.id));
    disposed = false;
    views = new Map();
    /**
     * @param ctx - Client root Context with Gateway and terminal Remote namespace.
     * @param remote - generated terminal namespace.
     */
    constructor(ctx, remote) {
        super(ctx, 'webTerminals');
        this.remote = remote;
        ctx.effect(() => async () => {
            this.disposed = true;
            const detaching = [...this.views.values()].flatMap(views => [...views.values()].map(view => view.dispose()));
            this.views.clear();
            await Promise.all([...detaching, ...this.closing.values()]);
        }, 'terminal-controller.client.views');
        for (const request of this.requests.pending())
            this.cleanup(request);
    }
    /**
     * Return the stable model for one sidebar occurrence.
     * @param sessionId - owning Session.
     * @param key - sidebar occurrence key.
     * @param terminalId - existing Host identity when restoring a listed terminal.
     * @param shellPath - explicit shell for a new terminal; restored terminals retain their own shell.
     * @returns its observable state and terminal commands.
     */
    view(sessionId, key, terminalId, shellPath) {
        let views = this.views.get(sessionId);
        if (views === undefined) {
            views = new Map();
            this.views.set(sessionId, views);
        }
        let view = views.get(key);
        if (view === undefined) {
            const id = terminalId ?? randomUUID();
            view = new TerminalView(sessionId, this.remote, this.ctx.remote, id, terminalId === undefined, shellPath);
            views.set(key, view);
            void view.refresh();
        }
        return view;
    }
    /**
     * Discover available launch choices on demand without allocating a PTY.
     * @param sessionId - target Session.
     * @param signal - the menu request lifetime.
     * @returns installed shells and the currently usable browser preference.
     */
    async launchShells(sessionId, signal) {
        const result = await this.remote.shells(sessionId, signal);
        if (!result.ok)
            throw new Error(result.error.message);
        const previous = preferredShell();
        return { shells: result.value, selectedShell: result.value.find(shell => shell.path === previous)?.path ?? result.value[0]?.path };
    }
    /**
     * Remember the guide selection before allocating its terminal tab.
     * @param path - shell selected from Host discovery.
     */
    selectShell(path) { rememberShell(path); }
    /**
     * Save a close intent and release the tab immediately; cleanup outlives DOM unmount and reload.
     * @param sessionId - owning Session.
     * @param key - sidebar occurrence key, including an inactive restored tab.
     * @param terminalId - restored identity if the tab has no model yet.
     */
    close(sessionId, key, terminalId) {
        const views = this.views.get(sessionId);
        const view = views?.get(key);
        const id = view?.id ?? terminalId;
        if (id === undefined)
            return;
        const request = { sessionId, id, title: view?.state.getSnapshot().title ?? key };
        this.closed.add(id);
        this.requests.save(request);
        views?.delete(key);
        if (views?.size === 0)
            this.views.delete(sessionId);
        this.cleanup(request, view);
    }
    /**
     * Query Host terminals that have neither a tab in this page nor an unfinished close.
     * @param sessionId - Session being displayed.
     * @returns terminals available for opening as recovered tabs.
     */
    async recover(sessionId) {
        const result = await this.remote.list(sessionId);
        if (!result.ok)
            throw new Error(result.error.message);
        const held = new Set([...(this.views.get(sessionId)?.values() ?? [])].map(view => view.id));
        const closing = new Set(this.requests.pending().map(request => request.id));
        return result.value.filter(info => !held.has(info.id) && !closing.has(info.id) && !this.closed.has(info.id));
    }
    /**
     * Retry a saved close request without reopening its tab.
     * @param id - failed terminal identity.
     */
    retryClose(id) {
        const record = this.requests.pending().find(item => item.id === id);
        if (record !== undefined)
            this.cleanup(record);
    }
    cleanup(record, view) {
        if (this.closing.has(record.id) || this.disposed)
            return;
        this.closeFailures.set(this.closeFailures.getSnapshot().filter(failure => failure.id !== record.id));
        const pending = (async () => {
            if (view !== undefined)
                await view.close();
            else {
                const result = await this.remote.close(record.sessionId, record.id);
                if (!result.ok)
                    throw result.error;
            }
            this.requests.remove(record.id);
        })().catch((error) => {
            if (remoteErrorOf(error)?.code === 'session/not-found') {
                this.requests.remove(record.id);
                return;
            }
            if (!this.disposed)
                this.closeFailures.set([...this.closeFailures.getSnapshot(), {
                        id: record.id, title: record.title,
                        message: error instanceof Error ? error.message : String(error),
                    }]);
        }).then(async () => {
            await view?.dispose();
            this.closing.delete(record.id);
        });
        this.closing.set(record.id, pending);
    }
}
/** Required Client transport and terminal namespace. */
export const inject = ['remote', 'remote.terminal'];
/**
 * Install the Client terminal models.
 * @param ctx - Client root Context.
 */
export function apply(ctx) {
    new ClientTerminals(ctx, ctx.remote.terminal);
}
//# sourceMappingURL=index.js.map