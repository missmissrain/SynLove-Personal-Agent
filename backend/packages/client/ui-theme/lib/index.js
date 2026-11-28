import z from "@deepseek-ai/schemastery";
//#region lib/types/theme-settings.js
/** Theme preferences stored in the Host user-settings document. */
/** Built-in preferences accepted at the registry and settings boundaries. */
const THEME_PREFERENCES = [
	"light",
	"dark",
	"system"
];
/** Settings namespace owned by the theme plugin. */
const THEME_SETTINGS_NAMESPACE = "ui-theme";
/** Field carrying the selected built-in theme preference. */
const THEME_PREFERENCE_FIELD = "preference";
/** Field carrying the conversation content font size. */
const FONT_SIZE_FIELD = "fontSize";
/** Default preference when the user-settings document has no override. */
const DEFAULT_PREFERENCE = "system";
/** Smallest accepted content font size (px). */
const FONT_SIZE_MIN = 12;
/** Largest accepted content font size (px). */
const FONT_SIZE_MAX = 17;
/** Content font size when the user-settings document has no override (px). */
const DEFAULT_FONT_SIZE = 14;
/** Durable theme schema; also the wire envelope the browser scope validates against. */
const ThemeSettingsSchema = z.object({
	[THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
	[FONT_SIZE_FIELD]: z.number().step(1).min(12).max(17).default(14)
});
//#endregion
//#region lib/types/boot-theme.js
/**
* Theme bootstrap row for the browser's pre-plugin interval. Each index
* render embeds the current durable built-in preference and content font size.
* Head CSS colors the document canvas before script execution; the body script
* installs the palette selector and font size that the client presenters adopt.
*/
const LIGHT_BACKGROUND = "#fff";
const DARK_BACKGROUND = "#151517";
/** CSS that colors the document canvas before any script executes. */
function bootThemeStyle(preference) {
	const light = `:root{color-scheme:light}body{background-color:${LIGHT_BACKGROUND};--dsh-boot-bg:${LIGHT_BACKGROUND}}`;
	const dark = `:root{color-scheme:dark}body{background-color:${DARK_BACKGROUND};--dsh-boot-bg:${DARK_BACKGROUND}}`;
	if (preference === "light") return light;
	if (preference === "dark") return dark;
	return `${light}@media(prefers-color-scheme:dark){${dark}}`;
}
/** Build the body script that installs the palette selector and content size. */
function bootThemeBodyScript(preference, fontSize) {
	return `(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', ${JSON.stringify(`${fontSize}px`)})
})()`;
}
/**
* Theme bootstrap rows: head CSS colors the document canvas before
* first paint, then the body script installs the palette selector and font
* size before the shell mount and module script.
* @param preference - Current Host-backed built-in preference.
* @param fontSize - Current Host-backed content font size in px.
* @returns head and body script rows in execution order.
*/
function bootThemeInjections(preference = DEFAULT_PREFERENCE, fontSize = 14) {
	return [{
		kind: "style",
		text: bootThemeStyle(preference)
	}, {
		kind: "script",
		placement: "body",
		text: bootThemeBodyScript(preference, fontSize)
	}];
}
//#endregion
//#region lib/types/index.js
/** Host registration for the browser theme preference and pre-plugin palette. */
const THEME_NAMESPACE = THEME_SETTINGS_NAMESPACE;
/** Read the registered theme section or the schema defaults without a settings provider. */
function readSection(ctx) {
	const fallback = {
		preference: DEFAULT_PREFERENCE,
		fontSize: 14
	};
	const settings = ctx.get("settings");
	if (settings === void 0) return fallback;
	const section = settings.get(THEME_NAMESPACE);
	if (section === void 0) return fallback;
	return section;
}
/**
* Register the durable theme section when the optional settings service is
* composed, and answer every index injection collection with the current
* theme bootstrap row.
* @param ctx - Host context that may acquire the settings service.
*/
function apply(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema);
	});
	ctx.on("webserver/index-inject", (table) => {
		const section = readSection(ctx);
		table.push(...bootThemeInjections(section.preference, section.fontSize));
	}, { prepend: true });
}
//#endregion
export { DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, FONT_SIZE_FIELD, FONT_SIZE_MAX, FONT_SIZE_MIN, THEME_PREFERENCES, THEME_PREFERENCE_FIELD, THEME_SETTINGS_NAMESPACE, apply };
