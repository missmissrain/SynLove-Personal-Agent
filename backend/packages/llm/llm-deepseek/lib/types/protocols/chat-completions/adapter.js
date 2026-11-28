/**
 * `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-deepseek/adapter
 */
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
import { attributionHeaders, contentHasImage, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { serializeRequest, serializeRequestWithImages } from "./serialize.js";
import { deepSeekImageRequestPricing, resolveRequestImageTarget } from "../../common/request-pricing.js";
import { catalogModelInfo, modelInfo } from "../../common/model-info.js";
import { FileResolutionFailure, RequestFiles } from "../../common/request-files.js";
import { prepareRequestExtensions } from "../../common/request-extensions.js";
import { parseSse } from "./sse.js";
import { translate } from "./translate.js";
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
function collectImageRefs(content, refs) {
    for (const block of content) {
        if (block.type === 'image' && block.offloaded !== true)
            refs.set(block.attachment.attachmentId, block.attachment);
        else if (block.type === 'tool-result')
            collectImageRefs(block.content, refs);
    }
}
async function prepareRequestImages(options, attachments, model, signal) {
    const refs = new Map();
    for (const message of options.messages)
        collectImageRefs(message.content, refs);
    const orderedRefs = [...refs.values()];
    const projected = await Promise.all(orderedRefs.map(ref => attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal)));
    return new Map(orderedRefs.map((ref, index) => ([ref.attachmentId, projected[index]])));
}
function providerRetryAfterMs(value) {
    if (value === null)
        return undefined;
    if (/^\d+$/.test(value)) {
        const delay = Number(value) * 1_000;
        return Number.isFinite(delay) && delay > 0 ? delay : undefined;
    }
    const delay = Date.parse(value) - Date.now();
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
function requestId(headers) {
    const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id');
    return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}
/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status, error) {
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 413)
        return 'INVALID_REQUEST';
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
    if (isQuotaExceededError(detail))
        return QUOTA_EXCEEDED_CODE;
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        if (isContextWindowExceededError(detail))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
/**
 * The first real `LlmAdapter`. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class ChatCompletionsAdapter extends LlmAdapter {
    config;
    files;
    constructor(config) {
        super();
        this.config = config;
        this.files = config.resolveFiles();
    }
    providerInfo(provider) {
        return { id: provider, name: 'DeepSeek' };
    }
    providerRetryPolicy(_provider) {
        return this.config.options().retryPolicy;
    }
    imageRequestPricing(_provider, model) {
        // The same access resolution the serializer uses, so priced handle and
        // placeholder text matches what the request actually sends.
        const attachments = this.config.resolveAttachments?.();
        const resolveAccess = attachments === undefined
            ? undefined
            : (ref) => (this.config.resolveImageAccess?.(attachments, ref));
        return deepSeekImageRequestPricing(this.config.options(), model, resolveAccess);
    }
    listModels(provider) {
        return Promise.resolve(this.config.options().models.map(model => catalogModelInfo(provider, model)));
    }
    resolveModel(provider, model, _signal) {
        return Promise.resolve(modelInfo(this.config.options(), provider, model));
    }
    prepareCall(provider, model, _signal) {
        const connection = this.config.options();
        return Promise.resolve({
            model: modelInfo(connection, provider, model),
            stream: options => this.streamWithConnection(options, connection),
        });
    }
    stream(options) {
        return this.streamWithConnection(options, this.config.options());
    }
    async *streamWithConnection(options, connection) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            // One resolution per stream call: connection facts and the credential
            // freeze here and hold for this whole request, so an in-flight stream
            // never observes a configuration change and the next call re-resolves.
            // The key resolves *from this snapshot*, so an endpoint and the secret
            // sent to it can never come from different configuration generations.
            const hasImages = options.messages.some(message => contentHasImage(message.content));
            let attachments;
            if (hasImages) {
                const model = connection.models.find(entry => entry.id === options.model);
                if (model?.inputModalities?.includes('image') !== true) {
                    throw new LlmError(`DeepSeek model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT');
                }
                attachments = this.config.resolveAttachments?.();
                if (attachments === undefined) {
                    throw new LlmError('DeepSeek image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT');
                }
            }
            const apiKey = await this.config.resolveApiKey(connection);
            const userId = this.config.resolveUserId();
            const consumer = new AbortController();
            const upstream = options.signal === undefined
                ? consumer.signal
                : AbortSignal.any([options.signal, consumer.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
            const iterator = this.request(options, watchdog.signal, connection, apiKey, userId, attachments, () => { watchdog.pulse(); })[Symbol.asyncIterator]();
            let exhausted = false;
            try {
                while (true) {
                    const result = await watchdog.next(iterator);
                    if (result.done) {
                        exhausted = true;
                        return;
                    }
                    yield result.value;
                }
            }
            catch (error) {
                if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
                    throw new LlmError(`DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
                }
                if (options.signal?.aborted) {
                    throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error });
                }
                if (error instanceof LlmError)
                    throw error;
                throw new LlmError(`DeepSeek API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
            }
            finally {
                consumer.abort('DeepSeek stream consumer stopped');
                if (!exhausted && iterator.return !== undefined) {
                    try {
                        await iterator.return();
                    }
                    catch (_abortedTransportTeardown) {
                        // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
                    }
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
    async *request(options, signal, connection, apiKey, userId, attachments, onActivity) {
        const headers = {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'accept': 'text/event-stream',
            ...attributionHeaders(),
            'x-deepseek-harness-user-id': String(userId),
            ...options.sessionId !== undefined
                ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
                : {},
            ...options.purpose === 'compaction'
                ? { 'x-deepseek-harness-compact': '1' }
                : {},
        };
        const fileConnection = { baseURL: connection.baseURL, apiKey, protocol: connection.protocol };
        const model = connection.models.find(entry => entry.id === options.model);
        const resolveImageAccess = attachments === undefined
            ? undefined
            : (ref) => this.config.resolveImageAccess?.(attachments, ref);
        const imageAccessOptions = resolveImageAccess === undefined ? {} : { resolveImageAccess };
        const requestOptions = options;
        const requestImages = attachments === undefined || model === undefined
            ? new Map()
            : await prepareRequestImages(requestOptions, attachments, model, signal);
        let representation = 'file';
        const requestFiles = new RequestFiles(this.files, fileConnection, connection.filePolicy, connection.filesApiTimeoutMs, signal, onActivity);
        while (true) {
            requestFiles.beginAttempt();
            let body;
            if (attachments === undefined) {
                body = serializeRequest(requestOptions, connection.defaults);
            }
            else if (representation === 'base64') {
                body = await serializeRequestWithImages(requestOptions, {
                    representation: { kind: 'base64' },
                    requestImages,
                    ...imageAccessOptions,
                    maxRequestImageBytes: connection.maxInlineRequestImageBytes,
                    maxImagesPerRequest: connection.maxImagesPerRequest,
                    byteQuantum: connection.inlineImageOffloadByteQuantum,
                    countQuantum: connection.imageOffloadCountQuantum,
                }, connection.defaults);
            }
            else {
                try {
                    body = await serializeRequestWithImages(requestOptions, {
                        representation: {
                            kind: 'file',
                            resolveFileId: (version, _block, location) => requestFiles.resolve(version, location),
                        },
                        requestImages,
                        ...imageAccessOptions,
                        maxRequestImageBytes: connection.maxRequestFilesBytes,
                        maxImagesPerRequest: connection.maxImagesPerRequest,
                        byteQuantum: connection.imageOffloadByteQuantum,
                        countQuantum: connection.imageOffloadCountQuantum,
                    }, connection.defaults);
                }
                catch (error) {
                    if (!(error instanceof FileResolutionFailure))
                        throw error;
                    representation = 'base64';
                    continue;
                }
            }
            const extensions = await prepareRequestExtensions(body, {
                signal,
                ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
                ...options.purpose === undefined ? {} : { purpose: options.purpose },
            }, this.config.prepareExtensions);
            // TODO(http): adopt the Cordis HTTP service when shared transport configuration
            // outweighs its additional runtime dependencies.
            let response;
            try {
                response = await fetch(`${connection.baseURL}/chat/completions`, {
                    method: 'POST',
                    headers,
                    body: extensions.payload,
                    signal,
                });
            }
            catch (error) {
                if (signal.aborted)
                    throw error;
                throw new LlmError(`DeepSeek API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
            }
            if (!response.ok) {
                let message = `DeepSeek API error (HTTP ${response.status})`;
                let providerError;
                const rawResponse = await response.text();
                try {
                    const parsed = JSON.parse(rawResponse);
                    providerError = parsed.error;
                    if (providerError?.message)
                        message = providerError.message;
                }
                catch {
                    // The HTTP status remains authoritative when a gateway returns malformed JSON.
                }
                const detail = [providerError?.code, providerError?.type, providerError?.message]
                    .filter((field) => typeof field === 'string')
                    .join(' ');
                if (await requestFiles.retry(detail))
                    continue;
                message = requestFiles.errorMessage(response.status, message, detail);
                const delay = providerRetryAfterMs(response.headers.get('retry-after'));
                const id = requestId(response.headers);
                throw new LlmError(message, httpErrorCode(response.status, providerError), {
                    cause: new Error(rawResponse.length > 0 ? rawResponse : `DeepSeek HTTP ${response.status}`),
                    status: response.status,
                    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
                    ...id === undefined ? {} : { requestId: id },
                });
            }
            await extensions.accept();
            if (!response.body) {
                throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE');
            }
            yield* translate(parseSse(response.body, onActivity));
            return;
        }
    }
}
//# sourceMappingURL=adapter.js.map