import { PresentedOpenController } from "./present-open.js";
import { PresentRow } from "./PresentRow.js";
import { Deliverables, selectDeliverables } from "./Deliverables.js";
import { en, NS, zh } from "./locales.js";
import { deliverablesDefinition, presentedForClosing, producedFileMentions, selectProducedFiles, } from "./turn-deliverables.js";
export { ProducedFiles } from "./ProducedFiles.js";
export { producedForClosing } from "./turn-deliverables.js";
/** Required services for the tail-slot registration and its dictionaries. */
export const inject = ['slots', 'locale', 'uiConversation', 'remote', 'remote.session'];
/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    const opener = new PresentedOpenController();
    ctx.effect(() => () => opener.dispose());
    ctx.on('connection/reset', () => { opener.resetHost(); });
    ctx.uiConversation.events.register(deliverablesDefinition);
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-deliverables: dictionaries');
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        select: selectDeliverables,
        locale: NS,
        inject: () => ({
            hooks: { presentedOpen: opener.state, presentedHost: opener.host },
            reloadPresentedHost: () => opener.loadHost(),
            openPresented: (sessionId, seq, index, action) => opener.open(sessionId, seq, index, action),
        }),
    }, Deliverables));
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'present', locale: NS }, PresentRow));
    // The prose side of the same vocabulary: the chat view reaches this face
    // via ctx.get, so its absence — this plugin composed out — is the off state.
    const t = ctx.locale.bind(NS);
    const mentions = {
        forClosing(owner) {
            const paths = selectProducedFiles(owner);
            const presented = presentedForClosing(owner);
            if (paths === null && presented.length === 0)
                return undefined;
            return producedFileMentions([...new Set([...paths ?? [], ...presented.map(file => file.path)])], owner.openFile, path => t('presented.previewButton', { name: path }));
        },
    };
    ctx.provide('chatFileMentions', mentions);
}
//# sourceMappingURL=index.js.map