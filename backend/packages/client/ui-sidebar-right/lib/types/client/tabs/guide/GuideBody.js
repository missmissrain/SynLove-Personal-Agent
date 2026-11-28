import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CompassGlyph, CubeGlyph } from "./GuideTitle.js";
import css from './GuideBody.module.css';
/** Entry count past which the guide drops the capsules' descriptions to stay light. */
const MAX_DESCRIBED_ENTRIES = 4;
/** One entry capsule: the contributing type's glyph and title, and its description while the guide is short. */
function EntryBox({ entry, described, onPick }) {
    const Icon = entry.icon ?? CubeGlyph;
    const description = described ? entry.description?.() : undefined;
    return (_jsxs("button", { type: "button", className: css.entry, "data-sidebar-right-guide-entry": entry.kind, onClick: () => { onPick(entry); }, children: [_jsx("span", { className: css.entryIcon, children: _jsx(Icon, { size: description === undefined ? 22 : 26, className: entry.icon === undefined ? css.placeholderInk : undefined }) }), _jsxs("span", { className: css.entryText, children: [_jsx("span", { className: css.entryTitle, children: entry.title() }), description !== undefined && _jsx("span", { className: css.entryDescription, children: description })] })] }));
}
/** The shipped guide: the tab's own compass over the doors out of the column. */
function ShippedGuide({ children }) {
    return (_jsxs("div", { className: css.guide, "data-sidebar-right-guide": true, children: [_jsx("span", { className: css.hero, "aria-hidden": "true", children: _jsx(CompassGlyph, { size: 56 }) }), children] }));
}
/** The guide tab's body, replaceable through its chain child. */
export function GuideBody({ useTabInfo, useGuideEntries, renderSlot, renderSlotChain }) {
    const { tab } = useTabInfo();
    const entries = useGuideEntries(entries => entries);
    const options = {
        hookContext: useTabInfo,
        fallback: (_jsx(ShippedGuide, { children: entries.map((entry) => {
                const described = entries.length <= MAX_DESCRIBED_ENTRIES;
                const description = described ? entry.description?.() : undefined;
                return _jsx("div", { className: css.entryCell, children: renderSlot('sidebar.right.tab.guide.entry', {
                        entryId: entry.id, kind: entry.kind, title: entry.title(),
                        ...description === undefined ? {} : { description },
                    }, {
                        entryKey: entry.providerId, hookContext: useTabInfo,
                        fallback: _jsx(EntryBox, { entry: entry, described: described, onPick: (selected) => { tab.actions.openTab(selected.kind, { replaceTab: true }); } }),
                    }) }, JSON.stringify([entry.providerId, entry.id]));
            }) })),
    };
    return renderSlotChain('sidebar.right.tab.guide', {}, options);
}
//# sourceMappingURL=GuideBody.js.map