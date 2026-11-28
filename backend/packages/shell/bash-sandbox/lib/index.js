import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature, matchesSignature as matchesSignature$1 } from "@deepseek-ai/dsh-sandbox";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
//#region lib/types/helpers.js
/**
* Classify a failed run against the selected backend's denial dialect.
* @param result - settled foreground run.
* @param signatures - case-insensitive denial substrings from the active wrap.
* @returns whether the failed run matches that denial dialect.
*/
function classifyDenial(result, signatures) {
	return matchesSignature(result.exitCode, result.stderr.text, signatures);
}
//#endregion
//#region lib/types/index.js
/**
* Sandbox-consuming bash executor. It wraps the exact local bash argv through
* `ctx.sandbox`, inherits local process mechanics, and reports the selected
* mode, enforcement, and denial facts. Positive runner-executable evidence
* identifies a broken confinement runner: foreground calls throw
* `SANDBOX_UNAVAILABLE`, while background processes carry `runnerFailed`;
* other provider rejections retain stage-neutral local-executor semantics. The
* tool owns approval and passes a complete per-call policy.
* @module @deepseek-ai/dsh-bash-sandbox
*/
/**
* Registers as `ctx.shell` in place of the local executor and requires a
* `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the tool layer is
* unchanged. Tool calls pass the calling session's resolved policy; direct
* calls fall back to deployment policy. `result.sandbox` reports the mode and
* enforcement actually used.
*/
var SandboxBashExecutor = class extends LocalBashExecutor {
	static inject = [
		"subprocess",
		"sandbox",
		"sandboxPolicy"
	];
	mode;
	/**
	* Per-process confinement facts retained until settlement. Providers may
	* vary enforcement and diagnostic dialect between overlapping calls, so a
	* shared latest-wrap value would classify a process against the wrong facts.
	* Unconfined processes have no entry.
	*/
	processFacts = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, config);
		this.mode = ctx.sandboxPolicy.defaultMode;
	}
	/** The configured default mode — the capability fact the tool layer reads. */
	get sandboxMode() {
		return this.mode;
	}
	/**
	* Stamp a complete per-call policy onto the spec. Tool calls supply the
	* calling session's resolved mode and root; lower-level callers fall back to
	* the deployment policy.
	*/
	resolve(request) {
		return {
			...super.resolve(request),
			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
		};
	}
	async run(spec) {
		const policy = spec.sandboxPolicy;
		const { mode } = policy;
		if (mode === "danger-full-access") return {
			...await super.run(spec),
			sandbox: {
				mode,
				denied: false
			}
		};
		let confined;
		let result;
		let spawnRequested;
		try {
			({result, spawnRequested} = await this.runArgv(spec, async (signal) => {
				const prepared = await this.confine(spec.command, {
					...policy,
					mode
				}, signal);
				signal.throwIfAborted();
				confined = prepared;
				return prepared.argv;
			}));
		} catch (error) {
			if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
			if (confined !== void 0 && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new SandboxUnavailableError(mode, String(error));
			throw error;
		}
		if (!spawnRequested) return {
			...result,
			sandbox: {
				mode,
				denied: false
			}
		};
		const facts = confined;
		const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, facts.runnerFailureRules);
		if (runnerFailure !== void 0) throw new SandboxUnavailableError(mode, runnerFailure.detail);
		return {
			...result,
			sandbox: {
				mode,
				denied: classifyDenial(result, facts.denialSignatures),
				enforcement: facts.enforcement
			}
		};
	}
	async start(spec) {
		const policy = spec.sandboxPolicy;
		const { mode } = policy;
		if (mode === "danger-full-access") return super.start(spec);
		const confined = await this.confine(spec.command, {
			...policy,
			mode
		}, spec.signal);
		spec.signal?.throwIfAborted();
		let proc;
		try {
			proc = this.startArgv(spec, confined.argv);
		} catch (error) {
			if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new SandboxUnavailableError(mode, String(error));
			throw error;
		}
		const { enforcement, denialSignatures, runnerFailureRules } = confined;
		this.processFacts.set(proc, {
			mode,
			enforcement,
			denialSignatures,
			runnerFailureRules,
			runnerProgram: confined.argv[0],
			workdir: spec.workdir
		});
		return proc;
	}
	/**
	* Stamp per-process sandbox facts before `done` settles. Full-access processes
	* have no facts; signal deaths are not denials.
	*/
	onProcessDone(proc, stderr, providerRejected, providerError) {
		const facts = this.processFacts.get(proc);
		if (facts !== void 0) {
			this.processFacts.delete(proc);
			const runnerFailed = providerRejected ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir) : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== void 0;
			proc.sandbox = {
				mode: facts.mode,
				denied: !runnerFailed && matchesSignature$1(proc.exitCode, stderr, facts.denialSignatures),
				enforcement: facts.enforcement,
				...runnerFailed ? { runnerFailed } : {}
			};
		}
		super.onProcessDone(proc, stderr, providerRejected, providerError);
	}
	/**
	* Wrap one shell command via the `ctx.sandbox` provider. Provider errors
	* propagate unchanged; the returned argv is handed directly to the local
	* executor's subprocess path.
	* @param command - shell source for the confined inner `bash -c`.
	* @param policy - resolved confined execution policy.
	* @param signal - cancellation of confinement preparation.
	* @returns the provider's exact argv and settlement-classification facts.
	*/
	confine(command, policy, signal) {
		return this.ctx.sandbox.confine([
			"bash",
			"-c",
			command
		], policy, signal);
	}
};
//#endregion
export { SandboxBashExecutor, SandboxBashExecutor as default };
