import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/** Sidebar terminal screen and connection recovery. */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import css from './TerminalBody.module.css';
import { TerminalTheme } from "./terminal-theme.js";
import { observeTerminalCursor } from "./terminal-cursor.js";
/**
 * Render the retained terminal with the application theme.
 * @param props - sidebar occurrence, model lookup and translated copy.
 * @returns the terminal screen and any pending or exceptional state.
 */
export function TerminalBody({ useTabInfo, useTerminal, useTheme, view, t }) {
    const { tab } = useTabInfo();
    const theme = useTheme(value => value);
    const model = view(tab.id);
    const state = useTerminal(tab.id);
    useEffect(() => model.mount(), [model]);
    if (state === undefined)
        return null;
    const error = state.issue === undefined ? state.error ?? state.info?.error : t(state.issue);
    let status;
    if (state.phase === 'idle' || state.phase === 'loading')
        status = t('loading');
    else if (state.phase === 'creating' || state.phase === 'connecting' || state.phase === 'disconnected')
        status = t(state.phase);
    else if (state.info?.state === 'exited')
        status = t('exited', { code: String(state.info.exitCode ?? '—') });
    else if (state.info?.state === 'failed')
        status = t('unavailable');
    else if (state.phase === 'closed')
        status = t('closed');
    const retry = state.phase === 'failed' || state.phase === 'disconnected';
    const readOnly = state.phase === 'connected' && state.info?.state === 'running' && !state.writable;
    return (_jsxs("section", { className: css.root, "data-sidebar-terminal": true, children: [(status !== undefined || retry || readOnly) && _jsxs("div", { className: css.status, role: "status", children: [status, readOnly && _jsxs(_Fragment, { children: [t('readonly'), " ", _jsx("button", { type: "button", onClick: () => { model.connect(); }, children: t('control') })] }), retry && (state.info === undefined
                        ? _jsx("button", { type: "button", onClick: () => { void model.refresh(); }, children: t('retry') })
                        : _jsx("button", { type: "button", onClick: () => { model.connect(); }, children: t('reconnect') }))] }), state.info !== undefined && _jsx(TerminalScreen, { state: state, model: model, visible: tab.visible, label: t('title'), theme: theme }), error !== undefined && _jsx("p", { className: css.error, role: "alert", children: t('failed', { message: error }) })] }));
}
/* oxlint-disable typescript/no-non-null-assertion -- React sets the DOM ref, then these effects initialize and use the emulator. */
function TerminalScreen({ state, model, visible, label, theme }) {
    const element = useRef(null);
    const terminal = useRef();
    const fit = useRef();
    const colors = useRef();
    const lastRevision = useRef(0);
    const current = useRef({ state, visible });
    current.current = { state, visible };
    useLayoutEffect(() => {
        const node = element.current;
        const xterm = new Terminal({ minimumContrastRatio: 4.5, cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scrollback: current.current.state.environment?.scrollback ?? 0 });
        const addon = new FitAddon();
        xterm.loadAddon(addon);
        xterm.open(node);
        const palette = new TerminalTheme(xterm);
        colors.current = palette;
        const cursor = observeTerminalCursor(xterm, node, () => palette.cursor);
        xterm.textarea?.setAttribute('aria-label', label);
        terminal.current = xterm;
        fit.current = addon;
        lastRevision.current = 0;
        const input = xterm.onData((data) => { model.write(data); });
        const measure = () => {
            if (!current.current.visible || !current.current.state.writable || node.clientWidth === 0 || node.clientHeight === 0)
                return;
            fitScreen(xterm, addon, current.current.state, model);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => {
            observer.disconnect();
            input.dispose();
            cursor.dispose();
            palette.dispose();
            xterm.dispose();
            terminal.current = undefined;
            fit.current = undefined;
        };
    }, [model]);
    useLayoutEffect(() => {
        const style = getComputedStyle(element.current);
        colors.current.update(style.backgroundColor, style.color);
    }, [theme, model]);
    useLayoutEffect(() => {
        const xterm = terminal.current;
        const render = state.render;
        if (render === undefined || render.revision <= lastRevision.current)
            return;
        lastRevision.current = render.revision;
        if (render.frame.type === 'snapshot') {
            xterm.reset();
            xterm.resize(render.frame.info.cols, render.frame.info.rows);
        }
        xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => { model.acknowledge(render.revision); });
    }, [state.render, model]);
    useLayoutEffect(() => {
        const xterm = terminal.current;
        xterm.options.disableStdin = !state.writable;
        if (visible && state.writable && element.current?.clientWidth && element.current.clientHeight) {
            fitScreen(xterm, fit.current, state, model);
        }
        else if (state.info !== undefined && !state.writable)
            xterm.resize(state.info.cols, state.info.rows);
    }, [visible, state.writable, state.info?.cols, state.info?.rows, model]);
    useEffect(() => {
        terminal.current.textarea?.setAttribute('aria-label', label);
    }, [label]);
    useEffect(() => { if (visible && state.writable)
        terminal.current.focus(); }, [visible, state.writable]);
    return _jsx("div", { className: css.screen, ref: element });
}
/* oxlint-enable typescript/no-non-null-assertion */
function fitScreen(xterm, fit, state, model) {
    const dimensions = fit.proposeDimensions();
    const environment = state.environment;
    if (dimensions === undefined || environment === undefined)
        return;
    const cols = Math.min(dimensions.cols, environment.maxCols);
    const rows = Math.min(dimensions.rows, environment.maxRows);
    if (cols < 2 || rows < 1)
        return;
    xterm.resize(cols, rows);
    model.resize(cols, rows);
}
//# sourceMappingURL=TerminalBody.js.map