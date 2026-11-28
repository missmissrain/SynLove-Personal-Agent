/** Prepare plugin-contributed request fields and commit their delivery after HTTP acceptance. */
import { LlmError } from '@deepseek-ai/dsh-llm';
/**
 * Merge contributions without replacing protocol-owned fields. Preparation and
 * acceptance failures retain the same error category across DeepSeek protocols.
 * @param body - serialized protocol request before extension fields.
 * @param options - request identity, purpose, and cancellation.
 * @param prepare - contributor registry captured for this adapter.
 * @returns HTTP payload and a commit to invoke only after a successful HTTP response.
 */
export async function prepareRequestExtensions(body, options, prepare) {
    let extensions;
    try {
        extensions = await prepare({ body, ...options });
    }
    catch (error) {
        throw new LlmError('DeepSeek request extension preparation failed', 'REQUEST_EXTENSION', { cause: error });
    }
    for (const field of Object.keys(extensions.fields)) {
        if (Object.hasOwn(body, field)) {
            throw new LlmError(`DeepSeek request extension field ${JSON.stringify(field)} collides with the base request`, 'REQUEST_EXTENSION');
        }
    }
    return {
        payload: JSON.stringify({ ...body, ...extensions.fields }),
        async accept() {
            try {
                await extensions.accept();
            }
            catch (error) {
                throw new LlmError('DeepSeek request extension acceptance failed', 'REQUEST_EXTENSION', { cause: error });
            }
        },
    };
}
//# sourceMappingURL=request-extensions.js.map