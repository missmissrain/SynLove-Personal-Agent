import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Shell launch menu owned by the terminal provider's guide entry. */
import { useEffect, useState } from 'react';
import { Button, IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { TerminalGuideIcon } from "./TerminalIcon.js";
import css from './TerminalGuide.module.css';
/**
 * Open the remembered shell from the card or choose another shell from its menu.
 * @param props - guide copy, enclosing tab actions and cancellable discovery.
 * @returns separate launch and menu buttons within one guide card.
 */
export function TerminalGuide({ title, description, kind, useTabInfo, loadShells, selectShell, t }) {
    const { tab } = useTabInfo();
    const [open, setOpen] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState({ phase: 'loading' });
    useEffect(() => {
        if (!open)
            return;
        const lifetime = new AbortController();
        void loadShells(lifetime.signal).then((choices) => {
            if (!lifetime.signal.aborted)
                setState({ phase: 'ready', choices });
        }, (error) => {
            if (!lifetime.signal.aborted)
                setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) });
        });
        return () => { lifetime.abort(); };
    }, [open, attempt, loadShells]);
    const items = state.phase === 'ready'
        ? state.choices.shells.map(shell => ({ id: shell.path, label: shell.name }))
        : state.phase === 'loading'
            ? [{ id: 'loading', label: t('shellLoading'), disabled: true }]
            : [{ id: 'error', label: t('failed', { message: state.message }), disabled: true }, { id: 'retry', label: t('retry') }];
    return _jsxs("div", { className: css.entry, "data-sidebar-right-guide-entry": kind, children: [_jsxs(Button, { variant: "ghost", className: css.main, onClick: () => { tab.actions.openTab('terminal', { replaceTab: true }); }, children: [_jsx(TerminalGuideIcon, { size: description === undefined ? 22 : 26, className: css.icon }), _jsxs("span", { className: css.text, children: [_jsx("span", { className: css.title, children: title }), description !== undefined && _jsx("span", { className: css.description, children: description })] })] }), _jsx(Menu, { open: open, portal: true, autoFocus: true, align: "end", className: css.menu, items: items.length === 0 ? [{ id: 'empty', label: t('shellEmpty'), disabled: true }] : items, selectedId: state.phase === 'ready' ? state.choices.selectedShell : undefined, onClose: () => { setOpen(false); }, onSelect: (path) => {
                    if (state.phase === 'failed') {
                        setState({ phase: 'loading' });
                        setAttempt(value => value + 1);
                        return;
                    }
                    selectShell(path);
                    setOpen(false);
                    tab.actions.openTab('terminal', { replaceTab: true, params: { shellPath: path } });
                }, anchor: _jsx(Button, { variant: "ghost", className: css.trigger, "aria-label": t('shell'), "aria-haspopup": "menu", "aria-expanded": open, onClick: () => { setState({ phase: 'loading' }); setOpen(value => !value); }, children: _jsx(IconChevronDownOutline14, {}) }) })] });
}
//# sourceMappingURL=TerminalGuide.js.map