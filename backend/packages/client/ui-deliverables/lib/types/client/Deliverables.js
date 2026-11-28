import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** Existing changed-file chips and explicitly declared files for a closing turn. */
import { useEffect, useState } from 'react';
import { Button, IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import { ProducedFiles } from "./ProducedFiles.js";
import { presentedForClosing, selectProducedFiles } from "./turn-deliverables.js";
import { presentedFileUrl } from "../presented.js";
import { PresentedFileCard } from "./PresentedFileCard.js";
import css from './Deliverables.module.css';
const COLLAPSED_PRESENTED_COUNT = 4;
/**
 * Claim turns containing modified paths or declared files.
 * @param owner - closing turn.
 * @returns matched files, or null for an empty turn.
 */
export function selectDeliverables(owner) {
    const produced = selectProducedFiles(owner) ?? [];
    const presented = presentedForClosing(owner);
    return produced.length + presented.length === 0 ? null : { produced, presented };
}
/**
 * Render workspace file actions and default-application buttons for declared files.
 * @param props - matched files, workspace opener, and localized copy.
 * @returns the closing turn's file rows.
 */
export function Deliverables({ matched, openFile, t, sessionId, useSessions, openPresented, usePresentedOpen, usePresentedHost, reloadPresentedHost }) {
    const [expanded, setExpanded] = useState(false);
    const cwd = useSessions(state => state.byId[sessionId]?.cwd);
    const states = usePresentedOpen(value => value);
    const host = usePresentedHost(value => value);
    const collapsible = matched.presented.length > COLLAPSED_PRESENTED_COUNT;
    const presented = collapsible && !expanded
        ? matched.presented.slice(0, COLLAPSED_PRESENTED_COUNT)
        : matched.presented;
    useEffect(() => {
        if (matched.presented.length > 0 && host === null)
            void reloadPresentedHost();
    }, [matched.presented.length, host, reloadPresentedHost]);
    return _jsxs(_Fragment, { children: [matched.produced.length > 0 && _jsx(ProducedFiles, { matched: matched.produced, openFile: openFile, t: t }), matched.presented.length > 0 && _jsxs("div", { className: css.root, "data-after-produced-files": matched.produced.length > 0 || undefined, children: [host === 'error' && _jsxs("div", { className: css.hostStatus, children: [_jsx("span", { children: t('presented.hostError') }), _jsx(Button, { size: "sm", onClick: () => { void reloadPresentedHost(); }, children: t('presented.retry') })] }), host !== null && host !== 'error' && !host.available && _jsx("span", { className: css.hostStatus, children: t('presented.unavailable') }), _jsx("div", { className: css.presented, "data-presented-files-row": true, "data-single": matched.presented.length === 1 ? true : undefined, children: presented.map(file => _jsx(PresentedFileCard, { file: file, cwd: cwd, phase: states[presentedFileUrl(sessionId, file.seq, file.index)], host: host === 'error' ? null : host, t: t, onPreview: () => { openFile(file.path); }, onAction: (action) => { void openPresented(sessionId, file.seq, file.index, action); } }, `${file.seq}:${file.index}`)) }), collapsible && _jsxs("button", { type: "button", className: css.toggle, "aria-expanded": expanded, "aria-label": t(expanded ? 'presented.collapseAria' : 'presented.expandAria', { count: matched.presented.length }), onClick: () => { setExpanded(value => !value); }, children: [_jsx("span", { children: t(expanded ? 'presented.collapse' : 'presented.all', { count: matched.presented.length }) }), expanded ? _jsx(IconChevronUpOutline14, {}) : _jsx(IconChevronDownOutline14, {})] })] })] });
}
//# sourceMappingURL=Deliverables.js.map