/**
 * Turn-scoped produced-file Definition and readers. Client-only and
 * model-free: the vocabulary comes from successful first-party mutation
 * calls, never presentation data or the closing prose.
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { basename, isPresentedData, isPresentedFile } from "../presented.js";
/**
 * Extract the path from a supported first-party mutation call. Session
 * `tool/call` events are root calls; PTC dispatch children do not enter this
 * Definition independently.
 * @param name - wire tool name.
 * @param argsRaw - model-produced JSON arguments.
 * @returns the mutation path, or null when the call is not a supported mutation.
 */
function mutationPath(name, argsRaw) {
    let args;
    try {
        args = JSON.parse(argsRaw);
    }
    catch {
        return null;
    }
    if (!isRecord(args))
        return null;
    switch (name) {
        case 'write':
            return typeof args.content === 'string' ? pathValue(args.file_path) : null;
        case 'edit':
            return validEditArgs(args) ? pathValue(args.file_path) : null;
        case 'str_replace_editor':
            return editorMutationPath(args);
        default:
            return null;
    }
}
/** Validate the fields that an `edit` execution requires. */
function validEditArgs(args) {
    return typeof args.old_string === 'string'
        && args.old_string.length > 0
        && typeof args.new_string === 'string'
        && args.old_string !== args.new_string
        && (args.replace_all === undefined || typeof args.replace_all === 'boolean');
}
/** Extract a path only from a complete mutating editor command. */
function editorMutationPath(args) {
    const path = pathValue(args.path);
    if (path === null)
        return null;
    switch (args.command) {
        case 'create':
            return typeof args.file_text === 'string' ? path : null;
        case 'str_replace':
            return typeof args.old_str === 'string'
                && args.old_str.length > 0
                && (args.new_str === undefined || typeof args.new_str === 'string')
                ? path
                : null;
        case 'insert':
            return typeof args.insert_line === 'number'
                && Number.isInteger(args.insert_line)
                && args.insert_line >= 0
                && typeof args.new_str === 'string'
                ? path
                : null;
        default:
            return null;
    }
}
/** A non-blank path preserves the exact spelling supplied to the tool. */
function pathValue(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
/** Narrow parsed JSON to an argument object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Files produced by one Turn data value.
 *
 * The source is the arguments of successful `write`, `edit`, and mutating
 * `str_replace_editor` calls, not the closing prose: a produced file must be
 * listed whether or not the model remembered to name it. Reads, unsupported
 * tools, malformed calls, and failed results contribute nothing. Paths keep
 * first-seen order and appear once, so a file written and then edited in the
 * same turn is one entry.
 *
 * The Conversation Location index owns turn membership before this function
 * runs, so paths cannot spill across turns and this derivation does not infer
 * boundaries from neighboring presentation Nodes.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced paths in first-seen order; empty when the turn wrote nothing.
 */
export function producedForClosing(data, seq = Number.POSITIVE_INFINITY) {
    if (data === undefined)
        return [];
    const paths = [];
    const seen = new Set();
    for (const produced of data.produced) {
        if (produced.seq > seq || seen.has(produced.path))
            continue;
        seen.add(produced.path);
        paths.push(produced.path);
    }
    return paths;
}
/**
 * Claim the turn-tail chain only when its closing turn produced files.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns Produced paths as the component's match, or null to decline before mount.
 */
export function selectProducedFiles(owner) {
    const paths = producedForClosing(owner.turn.data.get('deliverables'), owner.seq);
    return paths.length === 0 ? null : paths;
}
/** Turn-local successful mutation accumulator; it publishes no view Node. */
export const deliverablesDefinition = {
    kind: 'deliverables',
    match: (event) => {
        if (event.type === 'turn/start')
            return { id: String(event.data.turn), role: 'start' };
        if (event.type === 'tool/call')
            return { id: String(event.data.turn), role: 'update' };
        if (event.type === 'deliverables/presented')
            return isPresentedData(event.data) ? { id: String(event.data.turn), role: 'update' } : null;
        if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
            return { id: String(event.data.turn), role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'turn/start')
            throw new Error('deliverables start requires turn/start');
        return { turn: match.event.data.turn, calls: new Map(), produced: [] };
    },
    update: (context, match) => {
        if (match.event.type === 'deliverables/presented') {
            const { files } = match.event.data;
            const seq = match.event.seq;
            const presented = [];
            for (let index = 0; index < files.length; index += 1) {
                const file = files[index];
                if (isPresentedFile(file))
                    presented.push({ ...file, seq, index });
            }
            if (presented.length === 0)
                return context.state;
            return { ...context.state, presented: [...context.state.presented ?? [], ...presented] };
        }
        if (match.event.type === 'tool/call') {
            const calls = new Map(context.state.calls);
            calls.set(String(match.event.data.callId), mutationPath(match.event.data.name, match.event.data.arguments));
            return { ...context.state, calls };
        }
        if (match.event.type !== 'tool/result')
            return context.state;
        const result = match.event.data.message.content[0];
        if (result.isError === true)
            return context.state;
        const callId = String(match.event.data.message.source.callId);
        const path = context.state.calls.get(callId);
        return path === null || path === undefined
            ? context.state
            : { ...context.state, produced: [...context.state.produced, { seq: match.event.seq, path }] };
    },
    buildLocationData: (context, scope, previous) => {
        if (scope !== 'turn' || context.state === undefined)
            return null;
        if (previous?.kind === 'turn'
            && previous.turn === context.state.turn
            && previous.key === 'deliverables'
            && previous.value.produced === context.state.produced
            && previous.value.presented === context.state.presented)
            return previous;
        return {
            kind: 'turn',
            turn: context.state.turn,
            key: 'deliverables',
            value: { produced: context.state.produced, ...context.state.presented === undefined ? {} : { presented: context.state.presented } },
        };
    },
};
/**
 * Select the latest declaration of each path before the closing reply.
 * @param owner - closing turn and sequence.
 * @returns replayable deliveries in first-seen path order.
 */
export function presentedForClosing(owner) {
    const files = new Map();
    for (const file of owner.turn.data.get('deliverables')?.presented ?? []) {
        if (file.seq < owner.seq)
            files.set(file.path, file);
    }
    return [...files.values()];
}
export { basename } from "../presented.js";
/**
 * Resolves inline-code references against one turn's produced or delivered
 * paths. Exact paths resolve directly; a basename resolves only when exactly
 * one supplied path has that basename. Ambiguous and unknown tokens stay inert.
 * @param paths - The turn's produced or delivered paths, already deduplicated.
 * @param openFile - The chat view's file opener.
 * @param label - Localizes the accessible open-label for a resolved path.
 * @returns The resolver MarkdownText consumes; the full path rides `title`,
 * the same disambiguator the row's chips carry.
 */
export function producedFileMentions(paths, openFile, label) {
    return {
        resolve(value) {
            const path = paths.includes(value) ? value : onlyPathWithBasename(paths, value);
            if (path === undefined)
                return undefined;
            return { open: () => { openFile(path); }, label: label(path), title: path };
        },
    };
}
/** The single supplied path whose basename is exactly `value`, else undefined. */
function onlyPathWithBasename(paths, value) {
    const matches = paths.filter(path => basename(path) === value);
    return matches.length === 1 ? matches[0] : undefined;
}
//# sourceMappingURL=turn-deliverables.js.map