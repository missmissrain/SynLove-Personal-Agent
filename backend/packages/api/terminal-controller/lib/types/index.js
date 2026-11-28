var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import z from '@deepseek-ai/schemastery';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { discoverShells, resolveShell } from "./shells.js";
import { BrowserTerminal } from "./terminal.js";
/** Typed Remote control of transient Session-owned terminal processes. */
let TerminalController = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _environment_decorators;
    let _shells_decorators;
    let _list_decorators;
    let _create_decorators;
    let _follow_decorators;
    let _write_decorators;
    let _resize_decorators;
    let _rename_decorators;
    let _close_decorators;
    return class TerminalController extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _environment_decorators = [Remote];
            _shells_decorators = [Remote];
            _list_decorators = [Remote];
            _create_decorators = [Remote];
            _follow_decorators = [Remote({ mode: 'stream' })];
            _write_decorators = [Remote];
            _resize_decorators = [Remote];
            _rename_decorators = [Remote];
            _close_decorators = [Remote];
            __esDecorate(this, null, _environment_decorators, { kind: "method", name: "environment", static: false, private: false, access: { has: obj => "environment" in obj, get: obj => obj.environment }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _shells_decorators, { kind: "method", name: "shells", static: false, private: false, access: { has: obj => "shells" in obj, get: obj => obj.shells }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _list_decorators, { kind: "method", name: "list", static: false, private: false, access: { has: obj => "list" in obj, get: obj => obj.list }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _create_decorators, { kind: "method", name: "create", static: false, private: false, access: { has: obj => "create" in obj, get: obj => obj.create }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _follow_decorators, { kind: "method", name: "follow", static: false, private: false, access: { has: obj => "follow" in obj, get: obj => obj.follow }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _write_decorators, { kind: "method", name: "write", static: false, private: false, access: { has: obj => "write" in obj, get: obj => obj.write }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _resize_decorators, { kind: "method", name: "resize", static: false, private: false, access: { has: obj => "resize" in obj, get: obj => obj.resize }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _rename_decorators, { kind: "method", name: "rename", static: false, private: false, access: { has: obj => "rename" in obj, get: obj => obj.rename }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _close_decorators, { kind: "method", name: "close", static: false, private: false, access: { has: obj => "close" in obj, get: obj => obj.close }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        config = __runInitializers(this, _instanceExtraInitializers);
        static inject = ['subprocess', 'sandboxPolicy', 'sessionProjections', 'typert'];
        static Config = z.object({
            shell: z.union([z.object({
                    path: z.string().required(), name: z.string().required(), args: z.array(z.string()).default([]),
                }), z.const(undefined)]),
            shellCandidates: z.array(z.string().min(1)).default(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd']),
            maxTerminals: z.number().step(1).min(1).default(8),
            maxCols: z.number().step(1).min(2).default(500),
            maxRows: z.number().step(1).min(1).default(200),
            scrollback: z.number().step(1).min(0).default(1000),
            maxBufferedBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024),
            maxInputBytes: z.number().step(1).min(1).default(64 * 1024),
            disposeGraceMs: z.number().step(1).min(1).default(1000),
        });
        owners = new Map();
        lifetime = new AbortController();
        /**
         * @param ctx - Host context carrying typed Remote and execution providers.
         * @param config - validated terminal limits and optional shell profile.
         */
        constructor(ctx, config) {
            super(ctx, 'terminalController', { namespace: 'terminal' });
            this.config = config;
            ctx.on('internal/dispatch', (_mode, eventName, args) => {
                if (eventName !== 'session/event')
                    return;
                const [session, event] = args;
                if (event.type !== 'sandbox/mode')
                    return;
                const owner = this.owners.get(session.id);
                if (owner === undefined || owner.terminals.size + owner.pending.size + owner.allocations.size === 0)
                    return;
                const current = ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? ctx.sandboxPolicy.defaultMode;
                if (event.data.mode !== current)
                    throw new Error('Close browser terminals before changing the Session sandbox mode');
            }, { global: true });
            ctx.effect(() => async () => {
                this.lifetime.abort(new Error('Terminal controller disposed'));
                const results = await Promise.allSettled([...this.owners].map(([id, owner]) => this.disposeOwner(id, owner)));
                const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
                if (errors.length > 0)
                    throw new AggregateError(errors, 'Browser terminal cleanup failed');
            }, 'terminal-controller.processes');
        }
        /**
         * Read the Session working directory and terminal limits without resolving a shell.
         * @param agent - Session owner supplied by the Gateway.
         * @param signal - request cancellation.
         * @returns the Session workspace directory and terminal limits.
         */
        environment(agent, signal) {
            signal.throwIfAborted();
            const { sandboxPolicy } = this.execution(agent);
            return { cwd: sandboxPolicy.resolve({ session: agent.session }).workspaceRoot,
                maxInputBytes: this.config.maxInputBytes, maxCols: this.config.maxCols,
                maxRows: this.config.maxRows, scrollback: this.config.scrollback };
        }
        /**
         * Discover installed shells in the Session's execution environment.
         * @param agent - Session owner supplied by the Gateway.
         * @param signal - request cancellation.
         * @returns verified profiles, with the configured or system default first.
         */
        shells(agent, signal) {
            signal.throwIfAborted();
            return discoverShells(this.execution(agent).subprocess, this.config.shell, this.config.shellCandidates, signal);
        }
        /**
         * List retained terminals without resolving or activating an Agent.
         * @param sessionId - displayed Session identity, including offline history.
         * @returns terminals retained for this Host lifetime.
         */
        list(sessionId) {
            const owner = this.owners.get(sessionId);
            if (owner === undefined)
                return [];
            return [...owner.terminals.values(), ...owner.allocations.values()].map(terminal => terminal.info);
        }
        /**
         * Allocate an interactive shell once for a caller-generated identity.
         * @param agent - Session owner supplied by the Gateway.
         * @param request - initial dimensions and idempotency identity.
         * @param signal - allocation cancellation; committed terminals survive disconnection.
         * @returns the existing or newly committed terminal.
         */
        async create(agent, request, signal) {
            this.lifetime.signal.throwIfAborted();
            if (!/^[\w-]{1,128}$/u.test(request.id))
                throw new Error('Invalid terminal identity');
            this.dimensions(request.cols, request.rows);
            const owner = this.owner(agent);
            owner.lifetime.signal.throwIfAborted();
            this.requireOpen(owner, request.id);
            const existing = owner.terminals.get(request.id);
            if (existing !== undefined)
                return existing.info;
            const pending = owner.pending.get(request.id);
            if (pending !== undefined) {
                const terminal = await pending;
                this.requireOpen(owner, request.id);
                return terminal.info;
            }
            if (owner.allocations.has(request.id))
                throw new Error('Close the failed terminal allocation before creating it again');
            if (new Set([...owner.terminals.keys(), ...owner.pending.keys(), ...owner.allocations.keys()]).size >= this.config.maxTerminals)
                throw new RemoteError('terminal/limit-reached', 'Session terminal limit reached', { limit: this.config.maxTerminals });
            const allocation = this.spawn(agent, owner, request, AbortSignal.any([signal, this.lifetime.signal, owner.lifetime.signal]));
            owner.pending.set(request.id, allocation);
            try {
                const terminal = await allocation;
                owner.terminals.set(request.id, terminal);
                owner.allocations.delete(request.id);
                this.requireOpen(owner, request.id);
                return terminal.info;
            }
            finally {
                owner.pending.delete(request.id);
            }
        }
        /**
         * Attach to a terminal without binding its process lifetime to the transport.
         * @param agent - Session owner supplied by the Gateway.
         * @param id - terminal identity.
         * @param attachmentId - new exclusive input attachment.
         * @param signal - physical stream cancellation.
         * @returns screen recovery followed by output and metadata changes.
         */
        follow(agent, id, attachmentId, signal) {
            if (!/^[\w-]{1,128}$/u.test(attachmentId))
                throw new Error('Invalid terminal attachment identity');
            return this.terminal(agent, id).follow(attachmentId, signal);
        }
        /**
         * Deliver raw input, including Tab completion and control characters.
         * @param agent - Session owner supplied by the Gateway.
         * @param id - terminal identity.
         * @param attachmentId - current writable attachment.
         * @param data - input bytes represented as UTF-8 text.
         * @returns after provider input acceptance.
         */
        async write(agent, id, attachmentId, data) {
            if (Buffer.byteLength(data, 'utf8') > this.config.maxInputBytes)
                throw new Error('Terminal input exceeds the configured limit');
            await this.terminal(agent, id).write(attachmentId, data);
        }
        /**
         * Update the dimensions of the PTY and recovery screen.
         * @param agent - Session owner supplied by the Gateway.
         * @param id - terminal identity.
         * @param attachmentId - current writable attachment.
         * @param cols - column count.
         * @param rows - row count.
         * @returns after the resize completes.
         */
        async resize(agent, id, attachmentId, cols, rows) {
            this.dimensions(cols, rows);
            await this.terminal(agent, id).resize(attachmentId, cols, rows);
        }
        /**
         * Rename a terminal without changing its shell.
         * @param agent - Session owner supplied by the Gateway.
         * @param id - terminal identity.
         * @param title - nonempty display title, at most 120 characters.
         */
        rename(agent, id, title) {
            if (title.trim().length === 0 || title.length > 120)
                throw new Error('Terminal title must contain 1–120 characters');
            this.terminal(agent, id).rename(title.trim());
        }
        /**
         * Close an identity to future creation and kill its process range; repeated closes succeed.
         * @param agent - Session owner supplied by the Gateway.
         * @param id - terminal identity.
         * @returns after provider cleanup succeeds. A failure retains the terminal for retry.
         */
        async close(agent, id) {
            const owner = this.owner(agent);
            owner.closedIds.add(id);
            // create publishes the allocation before this wait settles; close owns it even if create then rejects.
            await owner.pending.get(id)?.catch(() => { });
            const terminal = owner.terminals.get(id);
            if (terminal !== undefined) {
                await terminal.close();
                owner.terminals.delete(id);
            }
            else {
                const allocation = owner.allocations.get(id);
                if (allocation === undefined)
                    return;
                await allocation.handle.terminate();
                owner.allocations.delete(id);
            }
        }
        owner(agent) {
            let owner = this.owners.get(agent.id);
            if (owner === undefined) {
                owner = { terminals: new Map(), pending: new Map(), allocations: new Map(), closedIds: new Set(), lifetime: new AbortController() };
                this.owners.set(agent.id, owner);
                const owned = owner;
                agent.ctx.effect(() => async () => { await this.disposeOwner(agent.id, owned); }, 'terminal-controller.owner');
            }
            return owner;
        }
        disposeOwner(id, owner) {
            if (owner.cleanup !== undefined)
                return owner.cleanup;
            owner.lifetime.abort(new Error('Terminal Session owner disposed'));
            owner.cleanup = (async () => {
                await Promise.allSettled(owner.pending.values());
                const results = await Promise.allSettled([
                    ...[...owner.terminals.values()].map(terminal => terminal.close()),
                    ...[...owner.allocations.values()].map(allocation => allocation.handle.terminate()),
                ]);
                const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
                if (errors.length > 0)
                    throw new AggregateError(errors, 'Session terminal cleanup failed');
                owner.terminals.clear();
                owner.allocations.clear();
                this.owners.delete(id);
            })().catch((error) => { delete owner.cleanup; throw error; });
            return owner.cleanup;
        }
        terminal(agent, id) {
            const terminal = this.owners.get(agent.id)?.terminals.get(id);
            if (terminal === undefined)
                throw new Error('Terminal no longer exists in this Session');
            return terminal;
        }
        requireOpen(owner, id) {
            if (owner.closedIds.has(id))
                throw new Error('Terminal was closed in this Session');
        }
        dimensions(cols, rows) {
            if (!Number.isSafeInteger(cols) || cols < 2 || cols > this.config.maxCols
                || !Number.isSafeInteger(rows) || rows < 1 || rows > this.config.maxRows)
                throw new Error('Terminal dimensions exceed the configured limits');
        }
        execution(agent) {
            // The Agent context selects execution providers but does not inject consumer services.
            const subprocess = agent.ctx.get('subprocess');
            const sandboxPolicy = agent.ctx.get('sandboxPolicy');
            if (subprocess === undefined || sandboxPolicy === undefined)
                throw new Error('The Session execution environment requires subprocess and sandbox policy providers');
            return { subprocess, sandboxPolicy };
        }
        async spawn(agent, owner, request, signal) {
            const environment = this.environment(agent, signal);
            const { subprocess, sandboxPolicy } = this.execution(agent);
            const shell = request.shellPath === undefined
                ? await resolveShell(subprocess, this.config.shell, signal)
                : (await this.shells(agent, signal)).find(candidate => candidate.path === request.shellPath);
            if (shell === undefined)
                throw new Error('Selected shell is not available in this execution environment');
            const policy = sandboxPolicy.resolve({ session: agent.session });
            let argv = [shell.path, ...shell.args];
            if (policy.mode !== 'danger-full-access') {
                const sandbox = agent.ctx.get('sandbox');
                if (sandbox === undefined)
                    throw new Error('The Session sandbox mode requires an execution sandbox provider');
                argv = (await sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)).argv;
            }
            const handle = await subprocess.spawnTerminal({
                argv, cwd: environment.cwd, cols: request.cols, rows: request.rows,
                terminalType: 'xterm-256color', env: { DSH_SESSION_ID: agent.id },
                graceMs: this.config.disposeGraceMs, signal,
            });
            const allocation = {
                handle,
                info: {
                    id: request.id, shell, title: shell.name, cwd: environment.cwd,
                    cols: request.cols, rows: request.rows, state: 'running', exitCode: null,
                },
            };
            owner.allocations.set(request.id, allocation);
            try {
                signal.throwIfAborted();
                return new BrowserTerminal(handle, allocation.info, this.config.scrollback, this.config.maxBufferedBytes);
            }
            catch (error) {
                allocation.info = { ...allocation.info, state: 'failed', error: error instanceof Error ? error.message : String(error) };
                try {
                    await handle.terminate();
                    owner.allocations.delete(request.id);
                }
                catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], 'Terminal allocation cleanup failed');
                }
                throw error;
            }
        }
    };
})();
export { TerminalController };
/** Browser terminal service plugin. */
export default TerminalController;
//# sourceMappingURL=index.js.map