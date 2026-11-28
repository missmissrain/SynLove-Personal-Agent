import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** File identity and explicit default-app or file-manager actions for one delivery. */
import { useRef, useState } from 'react';
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path';
import { Menu, FileTypeIcon, fileExtension, IconRightUpOutline16, IconChevronDownOutline14, IconFolderOpenOutline16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { basename } from "./turn-deliverables.js";
import css from './Deliverables.module.css';
function cardDescription(description, fallback) {
    const trimmed = description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim();
    return trimmed === undefined || trimmed === '' ? fallback : trimmed;
}
/**
 * Render independent file actions without nesting buttons inside a clickable card.
 * @param props - durable file metadata, Sidebar preview, Host capabilities, gesture status, and localized copy.
 * @returns the file card and its anchored action menu.
 */
export function PresentedFileCard({ file, cwd, phase, host, onPreview, onAction, t }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const previewRef = useRef(null);
    const pending = phase === 'opening' || phase === 'revealing';
    const menuDisabled = pending || host === null || !host.available;
    if (menuDisabled && menuOpen)
        setMenuOpen(false);
    const reveal = host?.fileManager ?? 'directory';
    const act = (action) => {
        setMenuOpen(false);
        previewRef.current?.focus();
        onAction(action);
    };
    const name = basename(file.path);
    const metadata = fileExtension(name).toUpperCase() || t('presented.file');
    const status = phase === undefined
        ? cardDescription(file.description, metadata)
        : t(reveal === 'directory' && phase === 'revealed' ? 'presented.directoryOpened'
            : reveal === 'directory' && phase === 'revealing' ? 'presented.directoryOpening'
                : reveal === 'directory' && phase === 'revealError' ? 'presented.directoryError' : `presented.${phase}`);
    return _jsxs("div", { className: css.file, "data-presented-file": true, children: [_jsx("button", { type: "button", className: css.cardPreview, title: resolveWorkspacePath(cwd, file.path), "aria-label": t('presented.previewCard', { name: file.path }), onClick: onPreview }), _jsx("span", { className: css.fileIcon, children: _jsx(FileTypeIcon, { path: file.path, size: 20 }) }), _jsxs("div", { className: css.fileBody, children: [_jsxs("div", { className: css.details, children: [_jsx("span", { className: css.fileName, children: name }), _jsxs("span", { className: css.description, role: phase === undefined ? undefined : 'status', "data-error": phase === 'error' || phase === 'revealError' || phase === 'nativeUnavailable' ? true : undefined, children: [_jsx("span", { className: css.secondaryText, children: status }), _jsx("span", { className: css.previewHint, children: t('presented.preview') })] })] }), _jsxs("div", { className: css.split, children: [_jsx("button", { ref: previewRef, type: "button", className: css.open, "aria-label": t('presented.previewButton', { name: file.path }), onClick: onPreview, children: t('presented.action') }), _jsx(Menu, { className: css.menuAnchor, open: menuOpen && !menuDisabled, autoFocus: true, portal: true, align: "end", onClose: () => { setMenuOpen(false); }, anchor: _jsx("button", { type: "button", className: css.chevron, disabled: menuDisabled, "aria-haspopup": "menu", "aria-expanded": menuOpen && !menuDisabled, "aria-label": t('presented.more', { name: file.path }), onClick: () => { setMenuOpen(value => !value); }, children: _jsx(IconChevronDownOutline14, { size: 11 }) }), items: [
                                    { id: 'open', icon: _jsx(IconRightUpOutline16, { size: 16, className: css.menuActionIcon }),
                                        label: t('presented.defaultApp') },
                                    { id: 'reveal', icon: _jsx(IconFolderOpenOutline16, {}),
                                        label: t(`presented.${reveal}`) },
                                ], onSelect: (id) => { act(id === 'reveal' ? 'reveal' : 'open'); } })] })] })] });
}
//# sourceMappingURL=PresentedFileCard.js.map