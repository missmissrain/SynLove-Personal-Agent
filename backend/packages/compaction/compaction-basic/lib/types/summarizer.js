/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */
import { contentHasImage, createUserMessage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm';
/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';
/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
    '',
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    '## Primary Request and Intent',
    "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
    '',
    '## Key Technical Concepts',
    '- [technologies, frameworks, patterns, and conventions in play]',
    '',
    '## Files and Code',
    '- [exact path: why it matters, key changes or snippets]',
    '',
    '## Errors and Fixes',
    '- [error: how it was resolved, plus any related user feedback]',
    '',
    '## Pending Jobs',
    '- [explicitly requested work not yet completed]',
    '',
    '## Current Work',
    '- [precisely what was in progress at this checkpoint]',
    '',
    '## Next Step',
    '- [the single next action, directly in line with the most recent request, or "(none)"]',
    '',
    '## Critical Context',
    '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
    '',
    'Rules:',
    '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    '- Capture user feedback and explicit instructions faithfully, especially corrections.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
    `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n');
/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
/**
 * 自适应输出上限：带思考的模型会先把 `maxTokens` 花在 thinking 上，
 * 导致摘要被截断（`MAX_TOKENS`）、压缩永远失败、上下文无限膨胀（实测踩过）。
 * 第一次截断就把上限翻倍再试一次（封顶 16k），仍不行才让调用方走机械兜底。
 */
function adaptiveCaps(base) {
    const ceiling = 16_384;
    const doubled = Math.min(Math.max(base, 1) * 2, ceiling);
    return doubled > base ? [base, doubled] : [base];
}
/** 摘要请求因输出上限被截断时抛出的错误码（见 {@link finishError}）。 */
function isMaxTokens(error) {
    return error?.code === 'MAX_TOKENS';
}
/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 *
 * 截断（`MAX_TOKENS`）会**自动把输出上限翻倍重试一次**：不这么做的话，
 * 带思考的模型会稳定地在 thinking 阶段吃掉全部额度，压缩从静默失效。
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(ctx, config, input, agent, signal) {
    const latest = agent.session.requestHeader()?.config;
    const configured = config.summarizationProvider.length === 0
        ? undefined
        : { provider: config.summarizationProvider, model: config.summarizationModel };
    const agentTarget = agent.options.provider !== undefined
        && agent.options.provider.length > 0
        && agent.options.model !== undefined
        && agent.options.model.length > 0
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined;
    const target = configured ?? latest ?? agentTarget;
    if (target === undefined) {
        throw new Error('no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields');
    }
    const messages = [
        ...input.messages,
        createUserMessage({
            content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
            source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
        }),
    ];
    let lastError;
    for (const cap of adaptiveCaps(config.maxTokens)) {
        signal?.throwIfAborted();
        const assembler = new BlockAssembler();
        const options = {
            provider: target.provider,
            model: target.model,
            messages,
            ...input.tools === undefined ? {} : { tools: [...input.tools] },
            maxTokens: cap,
            sessionId: agent.session.id,
            purpose: 'compaction',
            ...signal === undefined ? {} : { signal },
        };
        try {
            for await (const chunk of ctx.llm.stream(options))
                assembler.push(chunk);
            const error = finishError(assembler.finish);
            if (error !== undefined)
                throw error;
            const rawOutput = assembler.blocks();
            const summary = summaryText(rawOutput);
            if (!summary.some(block => block.text.trim().length > 0)) {
                throw new Error('summarization produced no text summary content');
            }
            return {
                summary,
                rawOutput,
                llmStreamCall: true,
                provider: options.provider,
                model: options.model,
                maxTokens: cap,
                ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
            };
        }
        catch (error) {
            // 只有"被输出上限截断"值得用更大的额度重试；其它错误原样抛出。
            if (!isMaxTokens(error))
                throw error;
            lastError = error;
        }
    }
    throw lastError;
}
/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary) {
    return [
        { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
        ...summary,
        { type: 'text', text: SUMMARY_CLOSE_TAG },
    ];
}
/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish) {
    switch (finish.kind) {
        case 'error':
        case 'aborted': {
            return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
        }
        case 'max-tokens': {
            const error = new Error('summarization truncated at the token cap (incomplete checkpoint)');
            error.code = 'MAX_TOKENS';
            return error;
        }
        default:
            return undefined;
    }
}
/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(blocks) {
    if (contentHasImage(blocks)) {
        throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT');
    }
    return blocks.filter((block) => block.type === 'text');
}
//# sourceMappingURL=summarizer.js.map