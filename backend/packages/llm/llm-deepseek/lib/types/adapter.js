/** Select a DeepSeek wire implementation from one validated configuration generation. */
import { assertNever } from '@deepseek-ai/dsh-util-values';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { ChatCompletionsAdapter } from "./protocols/chat-completions/adapter.js";
import { DeepSeekFileStore } from "./common/file-store.js";
import { DeepSeekMessagesAdapter } from "./protocols/messages/adapter.js";
/** One provider route with protocol-local transport and shared credentials and model configuration. */
export class DeepSeekAdapter extends LlmAdapter {
    dependencies;
    files;
    constructor(dependencies) {
        super();
        this.dependencies = dependencies;
        this.files = dependencies.resolveFiles?.() ?? new DeepSeekFileStore();
    }
    implementation() {
        const connection = this.dependencies.options();
        switch (connection.protocol) {
            case 'messages':
                return new DeepSeekMessagesAdapter({
                    connection: () => connection,
                    apiKey: this.dependencies.resolveApiKey,
                    userId: this.dependencies.resolveUserId,
                    attachments: () => this.dependencies.resolveAttachments?.(),
                    imageAccess: (ref) => {
                        const attachments = this.dependencies.resolveAttachments?.();
                        return attachments === undefined ? undefined : this.dependencies.resolveImageAccess?.(attachments, ref);
                    },
                    files: () => this.files,
                    prepareExtensions: this.dependencies.prepareExtensions,
                    ...this.dependencies.onReplayDegrade === undefined ? {} : { onReplayDegrade: this.dependencies.onReplayDegrade },
                });
            case 'chat-completions':
                return new ChatCompletionsAdapter({ ...this.dependencies, options: () => connection, resolveFiles: () => this.files });
            /* v8 ignore next -- protocol is validated at configuration resolution. */
            default: return assertNever(connection.protocol, 'DeepSeek protocol');
        }
    }
    providerInfo(provider) { return this.implementation().providerInfo(provider); }
    providerRetryPolicy(provider) { return this.implementation().providerRetryPolicy(provider); }
    listModels(provider) { return this.implementation().listModels(provider); }
    resolveModel(provider, model, signal) {
        return this.implementation().resolveModel(provider, model, signal);
    }
    imageRequestPricing(provider, model) {
        return this.implementation().imageRequestPricing(provider, model);
    }
    prepareCall(provider, model, signal) {
        return this.implementation().prepareCall(provider, model, signal);
    }
    stream(options) {
        return this.implementation().stream(options);
    }
}
//# sourceMappingURL=adapter.js.map