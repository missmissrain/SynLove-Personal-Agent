/** Direct Messages transport with one cancellable lifecycle per model request. */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { catalogModelInfo, modelInfo } from "../../common/model-info.js";
import { MESSAGES_FILES_BETA } from "../../common/files-api.js";
import { FileResolutionFailure, RequestFiles } from "../../common/request-files.js";
import { prepareRequestExtensions } from "../../common/request-extensions.js";
import { imagePricing, inlineImages, prepareFileIds, prepareImages } from "./images.js";
import { serialize } from "./serialize.js";
import { parseSse } from "./sse.js";
import { translate } from "./translate.js";
import { providerError, providerErrorDetail } from "./transport.js";
/** DeepSeek provider using Messages content and native thinking replay. */
export class DeepSeekMessagesAdapter extends LlmAdapter {
    dependencies;
    constructor(dependencies) {
        super();
        this.dependencies = dependencies;
    }
    providerInfo(provider) { return { id: provider, name: 'DeepSeek' }; }
    providerRetryPolicy(_provider) { return this.dependencies.connection().retryPolicy; }
    listModels(provider) {
        const connection = this.dependencies.connection();
        return Promise.resolve(connection.models.map(model => catalogModelInfo(provider, model)));
    }
    resolveModel(provider, model) {
        return Promise.resolve(modelInfo(this.dependencies.connection(), provider, model));
    }
    imageRequestPricing(_provider, model) {
        return imagePricing(this.dependencies.connection(), model, this.dependencies.imageAccess);
    }
    prepareCall(provider, model) {
        const connection = this.dependencies.connection();
        return Promise.resolve({ model: modelInfo(connection, provider, model), stream: options => this.generate(options, connection) });
    }
    stream(options) {
        return this.generate(options, this.dependencies.connection());
    }
    async *generate(options, connection) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const consumer = new AbortController();
            const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(signal, connection.streamIdleTimeoutMs, 'MESSAGES_IDLE'), false);
            const iterator = this.request(options, connection, watchdog.signal, () => { watchdog.pulse(); });
            try {
                while (true) {
                    const next = await watchdog.next(iterator);
                    if (next.done)
                        return;
                    yield next.value;
                }
            }
            catch (error) {
                if (timeoutOf(watchdog.signal, 'MESSAGES_IDLE') !== undefined)
                    throw new LlmError('DeepSeek Messages stream idle timeout', 'TIMEOUT', { cause: error });
                if (options.signal?.aborted)
                    throw new LlmError('DeepSeek Messages request aborted', 'ABORTED', { cause: error });
                if (error instanceof LlmError)
                    throw error;
                throw new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error });
            }
            finally {
                consumer.abort();
                try {
                    await iterator.return(undefined);
                }
                catch (_abortedRequestCleanup) {
                    // The request already settled; aborting its reader cannot replace that outcome.
                }
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    async *request(options, connection, signal, activity) {
        signal.throwIfAborted();
        const { messages, versions } = await prepareImages(options.messages, connection, options.model, this.dependencies.attachments(), this.dependencies.imageAccess, signal);
        const key = await this.dependencies.apiKey(connection);
        const files = new RequestFiles(this.dependencies.files(), { baseURL: connection.baseURL, apiKey: key, protocol: 'messages' }, connection.filePolicy, connection.filesApiTimeoutMs, signal, activity);
        let inline = false;
        while (true) {
            signal.throwIfAborted();
            files.beginAttempt();
            let fileIds;
            if (!inline) {
                try {
                    fileIds = await prepareFileIds(messages, versions, files);
                }
                catch (error) {
                    if (!(error instanceof FileResolutionFailure))
                        throw error;
                    inline = true;
                    continue;
                }
            }
            const history = inline ? inlineImages(messages, versions, connection) : messages;
            const body = serialize(options, connection, history, versions, this.dependencies.imageAccess, (reason) => {
                this.dependencies.onReplayDegrade?.({ provider: options.provider, model: options.model, reason });
            }, fileIds);
            const extensions = await prepareRequestExtensions(body, {
                signal,
                ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
                ...options.purpose === undefined ? {} : { purpose: options.purpose },
            }, this.dependencies.prepareExtensions);
            signal.throwIfAborted();
            const response = await fetch(`${connection.baseURL.replace(/\/+$/u, '')}/v1/messages`, {
                method: 'POST', signal, body: extensions.payload, redirect: 'error',
                headers: {
                    ...attributionHeaders(),
                    'content-type': 'application/json', 'accept': 'text/event-stream',
                    'x-api-key': key, 'anthropic-version': '2023-06-01',
                    ...fileIds === undefined || fileIds.size === 0 ? {} : { 'anthropic-beta': MESSAGES_FILES_BETA },
                    'x-deepseek-harness-user-id': this.dependencies.userId(),
                    ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
                    ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
                },
            });
            if (!response.ok) {
                const text = await response.text();
                let raw;
                try {
                    raw = JSON.parse(text);
                }
                catch (_nonJsonGatewayError) {
                    // HTTP status is authoritative when a gateway does not return JSON.
                }
                const detail = providerErrorDetail(raw);
                if (await files.retry(detail))
                    continue;
                const failure = providerError(raw, response.status, response.headers);
                const message = files.errorMessage(response.status, failure.message, detail);
                throw new LlmError(message, failure.code, { ...failure.failure, cause: new Error(text) });
            }
            await extensions.accept();
            if (response.body === null)
                throw new LlmError('DeepSeek Messages returned no response body', 'EMPTY_RESPONSE');
            yield* translate(parseSse(response.body, activity), options.model);
            return;
        }
    }
}
//# sourceMappingURL=adapter.js.map