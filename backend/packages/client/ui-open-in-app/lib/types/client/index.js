/**
 * Browser half of open-in-app: one Session-header split button opening the
 * session's workspace directory (the summary's `cwd`) in the remembered
 * installed application. Availability arrives once per page from the host
 * apps route; the last choice persists in the browser through the controller's
 * persisted snapshot store.
 */
import { OPEN_IN_APP_ICON_PREFIX } from '@deepseek-ai/dsh-host-open-in-app/shared';
import { OpenInAppController } from "./controller.js";
import { OpenInAppAction } from "./OpenInAppAction.js";
import { en, NS, zh } from "./locales.js";
/** Required services for locale registration and the header-slot contribution. */
export const inject = ['sessions', 'slots', 'locale'];
/**
 * Client plugin body: register the dictionaries and the header split button.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    const controller = new OpenInAppController();
    void controller.load();
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-in-app: dictionaries');
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'open-in-app',
        order: -10,
        locale: NS,
        inject: () => ({
            hooks: {
                openInAppApps: controller.apps,
                openInAppChoice: controller.choice,
            },
            launch: (appId, path) => controller.launch(appId, path),
            choose: (appId) => { controller.choose(appId); },
            iconUrl: appId => `${OPEN_IN_APP_ICON_PREFIX}/${appId}`,
        }),
    }, OpenInAppAction));
}
//# sourceMappingURL=index.js.map