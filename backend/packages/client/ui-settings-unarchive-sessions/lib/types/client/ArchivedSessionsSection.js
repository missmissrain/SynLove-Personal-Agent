import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Archived-session Settings page: the registry-global archive set joined with
 * the loaded Session summaries, newest archive first, filtered by one search
 * box, with one Unarchive action per row. An archive entry whose Session is
 * gone has no row and no action; the set itself stays host-owned.
 */
import { useMemo, useState } from 'react';
import { Button, IconSearchOutline16, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './ArchivedSessionsSection.module.css';
/** Localized compact relative time of one row's last activity. */
function timeLabel(updatedAt, now, t) {
    const { unit, n } = relativeTime(updatedAt, now);
    return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n });
}
/** Whether one row matches the normalized query in its title or Workspace label. */
function matches(row, normalizedQuery) {
    return normalizedQuery.length === 0
        || row.title.toLowerCase().includes(normalizedQuery)
        || row.workspace.toLowerCase().includes(normalizedQuery);
}
/**
 * Render the archived-session page.
 * @param props - composed slot props (see {@link ArchivedSessionsSectionProps}).
 * @returns the settings page element tree.
 */
export function ArchivedSessionsSection(props) {
    const { t, unarchive, useSessions, useWorkspaces } = props;
    const sessions = useSessions(state => state);
    const workspaces = useWorkspaces(state => state.items);
    const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds);
    const [query, setQuery] = useState('');
    const ungrouped = t('ungrouped');
    const summaries = sessions.byId;
    // Archive order is oldest first; the page lists the most recently archived
    // Session first. A member with no loaded summary is not addressable here.
    const rows = useMemo(() => {
        const owners = new Map();
        for (const workspace of workspaces) {
            for (const id of workspace.sessionIds)
                owners.set(id, workspace.title);
        }
        return [...archivedSessionIds].reverse().flatMap((id) => {
            const summary = summaries[id];
            if (summary === undefined)
                return [];
            return [{
                    id,
                    title: summary.displayTitle,
                    workspace: owners.get(id) ?? ungrouped,
                    updatedAt: summary.updatedAt,
                }];
        });
    }, [archivedSessionIds, workspaces, summaries, ungrouped]);
    if (sessions.phase !== 'ready')
        return _jsx("p", { className: css.status, children: t('loading') });
    const now = Date.now();
    const visible = rows.filter(row => matches(row, query.trim().toLowerCase()));
    const archived = archivedSessionIds.length > 0;
    return (_jsxs("div", { className: css.section, children: [_jsxs("div", { className: css.search, children: [_jsx(IconSearchOutline16, { "aria-hidden": "true" }), _jsx("input", { type: "search", value: query, placeholder: t('search'), "aria-label": t('search'), onChange: (event) => { setQuery(event.currentTarget.value); } })] }), !archived ? _jsx("p", { className: css.status, children: t('empty') }) : null, archived && rows.length === 0 ? _jsx("p", { className: css.status, children: t('unavailable') }) : null, rows.length > 0 && visible.length === 0 ? _jsx("p", { className: css.status, children: t('emptySearch') }) : null, visible.length > 0 ? (_jsx("ul", { className: css.list, children: visible.map(row => (_jsxs("li", { className: css.row, children: [_jsxs("span", { className: css.identity, children: [_jsx("span", { className: css.title, children: row.title }), _jsx("span", { className: css.meta, children: [row.workspace, timeLabel(row.updatedAt, now, t)].join(' · ') })] }), _jsx(Button, { variant: "outline", size: "sm", "aria-label": t('unarchiveNamed', { title: row.title }), onClick: () => {
                                unarchive(row.id).catch((reason) => {
                                    console.warn('session unarchive rejected:', reason);
                                });
                            }, children: t('unarchive') })] }, row.id))) })) : null] }));
}
//# sourceMappingURL=ArchivedSessionsSection.js.map