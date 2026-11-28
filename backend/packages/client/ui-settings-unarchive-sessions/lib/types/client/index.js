/** Archived-session Settings page, browser half. */
import { ArchivedSessionsSection } from "./ArchivedSessionsSection.js";
import { en, zh } from "./locales.js";
/** Dictionary namespace owned by this plugin. */
const NS = 'settings.archivedSessions';
/** Services required by the Settings registration and the archive write. */
export const inject = ['slots', 'locale', 'uiWorkspace'];
/** Contribute the archived-session page to Settings. */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-unarchive-sessions: dictionaries');
    const t = ctx.locale.bind(NS);
    const injected = () => ({
        unarchive: sessionId => ctx.uiWorkspace.unarchiveSession(sessionId),
    });
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'archived-sessions',
        order: 25,
        label: () => t('nav'),
        locale: NS,
        inject: injected,
    }, ArchivedSessionsSection));
}
//# sourceMappingURL=index.js.map