/** Shared native-open status for delivery cards and closing-message file mentions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { presentedFileUrl, PRESENT_HOST_PATH, isPresentedHost } from "../presented.js";
/** One browser plugin's file-open requests, cancelled when that plugin is disposed. */
export class PresentedOpenController {
    /** File action URLs key the state across Sessions, turns, and both clickable surfaces. */
    state = createSnapshotStore({});
    /** Native destination metadata, or a retryable read failure. */
    host = createSnapshotStore(null);
    loading;
    metadata = new AbortController();
    lifetime = new AbortController();
    pending = new Set();
    /**
     * Open a declared file once while a request for the same coordinates is pending.
     * Failures remain visible on the card and a later gesture retries them.
     * @param sessionId - viewed Session, including a fork's own identity.
     * @param seq - durable delivery event sequence.
     * @param index - original file index within that event.
     * @param action - default application open or file-manager reveal.
     * @returns after the Host acknowledges opening or the error state is published.
     */
    async open(sessionId, seq, index, action = 'open') {
        const url = presentedFileUrl(sessionId, seq, index);
        const phase = this.state.getSnapshot()[url];
        if (this.lifetime.signal.aborted || phase === 'opening' || phase === 'revealing')
            return;
        this.state.update((state) => { state[url] = action === 'open' ? 'opening' : 'revealing'; });
        const task = this.request(url, action);
        this.pending.add(task);
        try {
            await task;
        }
        finally {
            this.pending.delete(task);
        }
    }
    /**
     * Read the serving desktop metadata, coalescing concurrent reads; a later call retries failure.
     * @returns after metadata or a retryable error is published.
     */
    async loadHost() {
        if (this.lifetime.signal.aborted)
            return;
        if (this.loading !== undefined)
            return this.loading;
        this.host.set(null);
        const task = this.readHost(AbortSignal.any([this.lifetime.signal, this.metadata.signal]));
        this.loading = task;
        this.pending.add(task);
        try {
            await task;
        }
        finally {
            if (this.loading === task)
                this.loading = undefined;
            this.pending.delete(task);
        }
    }
    /** Invalidate desktop metadata on connection replacement; mounted cards request the new Host. */
    resetHost() {
        const wasLoading = this.loading !== undefined;
        this.metadata.abort();
        this.metadata = new AbortController();
        this.loading = undefined;
        this.host.set(null);
        if (wasLoading)
            void this.loadHost();
    }
    async readHost(signal) {
        let host = 'error';
        try {
            const response = await fetch(PRESENT_HOST_PATH, { signal });
            if (response.ok) {
                const value = await response.json();
                if (isPresentedHost(value))
                    host = value;
            }
        }
        catch {
            host = 'error';
        }
        if (!signal.aborted)
            this.host.set(host);
    }
    /** Cancel outstanding requests and wait until no request can publish state. */
    async dispose() {
        this.lifetime.abort();
        await Promise.all(this.pending);
    }
    async request(url, action) {
        const failure = action === 'open' ? 'error' : 'revealError';
        let phase = action === 'open' ? 'opened' : 'revealed';
        try {
            const response = await fetch(action === 'open' ? url : `${url}&action=reveal`, { method: 'POST', signal: this.lifetime.signal });
            if (!response.ok)
                phase = response.status === 422 ? 'nativeUnavailable' : failure;
        }
        catch {
            // Transport failures share the retryable card state with Host open failures.
            phase = failure;
        }
        if (!this.lifetime.signal.aborted)
            this.state.update((state) => { state[url] = phase; });
    }
}
//# sourceMappingURL=present-open.js.map