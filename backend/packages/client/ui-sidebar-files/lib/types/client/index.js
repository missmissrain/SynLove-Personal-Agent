import { FILES_ID, filesDefinition } from "./definition.js";
import { createList, filesFace } from "./face.js";
import { FilesBody } from "./FilesBody.js";
import { FilesTitle } from "./FilesTitle.js";
import { en, zh } from "./locales.js";
import { createFilesStore } from "./store.js";
/** This package's copy namespace. */
const NS = 'sidebarFiles';
/**
 * Required browser services: the tab registry, the keyed seat, the Remote
 * carrier and its namespace, and copy.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles'];
/**
 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
 * @param ctx - client root context carrying the registry, the slots, and the Remote face.
 */
export function apply(ctx) {
    const t = ctx.locale.bind(NS);
    ctx.effect(() => ctx.sidebarRightTabs.register(filesDefinition(t)), 'ui-sidebar-files: files type');
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-files: dictionaries');
    const store = createFilesStore();
    const inject = filesFace(createList(ctx.remote));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: FILES_ID, locale: NS, store, inject }, FilesBody)), 'ui-sidebar-files: files tab body');
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: FILES_ID }, FilesTitle)), 'ui-sidebar-files: files tab title');
}
//# sourceMappingURL=index.js.map