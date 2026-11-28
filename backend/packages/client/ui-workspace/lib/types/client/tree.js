import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path';
import { indexSubagentDescendants, } from "./subagent-lineage.js";
/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = '';
/**
 * Resolve the Workspace browser group that owns one Session.
 * @param workspaces - authoritative Workspace membership.
 * @param sessionId - Session whose browser group is required.
 * @returns owning Workspace id, or {@link UNGROUPED_KEY} when no Workspace accounts for it.
 */
export function owningGroupKey(workspaces, sessionId) {
    return workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
        ?.workspaceId ?? UNGROUPED_KEY;
}
/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or an empty ungrouped marker.
 */
export function workspaceLabel(cwd) {
    if (cwd === undefined || cwd === '')
        return '';
    const base = workspaceTitleOf(cwd);
    return base !== '' ? base : cwd;
}
/**
 * Project known account members by current Session recency.
 * @param sessionIds - authoritative account membership.
 * @param summaries - current Session summaries; members without a summary are omitted until it arrives.
 * @returns known members newest first, with Session identity as the deterministic tie-break.
 */
export function orderByRecency(sessionIds, summaries) {
    return sessionIds.flatMap((id) => {
        const summary = summaries[id];
        return summary === undefined ? [] : [{ id, updatedAt: summary.updatedAt }];
    })
        .sort((a, b) => {
        if (a.updatedAt !== b.updatedAt)
            return b.updatedAt - a.updatedAt;
        return a.id < b.id ? -1 : 1;
    })
        .map(member => member.id);
}
/**
 * Reconcile a browser-local manual order with current account membership.
 * @param memberIds - authoritative account membership.
 * @param savedOrder - previously saved browser-local order.
 * @param summaries - current Session summaries used to append newly known members by recency.
 * @returns retained saved slots followed by newly known members; departed members and unknown new members are omitted.
 */
export function reconcileManualOrder(memberIds, savedOrder, summaries) {
    const members = new Map(memberIds.map(id => [id, id]));
    const included = new Set();
    const ordered = [];
    for (const key of savedOrder ?? []) {
        const id = members.get(key);
        if (id === undefined || included.has(key))
            continue;
        ordered.push(id);
        included.add(key);
    }
    for (const id of orderByRecency(memberIds, summaries)) {
        if (included.has(id))
            continue;
        ordered.push(id);
        included.add(id);
    }
    return ordered;
}
/**
 * Keep the selected provisional New Session ahead of either base order.
 * @param order - recency or reconciled manual order.
 * @param currentBlank - selected blank Session in this account, when present.
 * @returns a copy with the selected blank first and no duplicate slot.
 */
export function pinCurrentBlank(order, currentBlank) {
    if (currentBlank === undefined)
        return [...order];
    return [currentBlank, ...order.filter(id => id !== currentBlank)];
}
/**
 * Ordinary sessions are visible; among blank sessions, only the current one
 * is visible. Subagent children use their parent header catalog; archived
 * sessions are visible nowhere, while their accounting slots remain so
 * unarchiving restores position.
 */
function sessionVisible(session, current, archived) {
    return session.origin !== 'subagent'
        && !archived.has(session.id)
        && (!session.blank || session.id === current);
}
/**
 * A blank session is the selected Workspace's provisional New Session row;
 * its canonical title never enters search (blank rows are query-excluded)
 * and the renderer localizes its display label.
 */
function sessionTitle(session) {
    return session.blank ? '' : session.displayTitle;
}
/** The list projection alone owns the best-effort active-Schedule indicator. */
function hasActiveSchedule(session) {
    return (session.projectionValues?.schedule?.length ?? 0) > 0;
}
/** Build one group without projecting session lineage into presentation. */
function buildGroup(key, workspaceId, cwd, createdAt, label, members) {
    return { key, workspaceId, cwd, createdAt, label, sessions: [...members] };
}
/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
function orderedUngrouped(members, stored, summaries) {
    const byId = new Map(members.map(session => [session.id, session]));
    const ids = stored === undefined
        ? orderByRecency(members.map(session => session.id), summaries)
        : reconcileManualOrder(members.map(session => session.id), stored, summaries);
    return ids.flatMap((id) => {
        const session = byId.get(id);
        /* v8 ignore next -- ids are projected exclusively from the members used to build byId. */
        return session === undefined ? [] : [session];
    });
}
/**
 * Group Sessions by Workspace: one group per caller-ordered entity, with
 * members resolved from caller-ordered sessionIds. Sessions outside every
 * Workspace trail in the browser-local Ungrouped order, which falls back to
 * recency before that order is initialized.
 */
function groupByWorkspace(list, workspaces, archived, ungroupedOrder) {
    const groups = [];
    const accounted = new Set();
    for (const workspace of workspaces) {
        const members = [];
        for (const id of workspace.sessionIds) {
            const summary = list.byId[id];
            if (summary === undefined)
                continue; // account may lead the list pull; the row appears when the summary lands
            accounted.add(id);
            if (!sessionVisible(summary, list.current, archived))
                continue;
            members.push(summary);
        }
        groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members));
    }
    const stray = list.ids
        .map(id => list.byId[id])
        .filter((s) => s !== undefined && !accounted.has(s.id) && sessionVisible(s, list.current, archived));
    if (stray.length > 0) {
        groups.push(buildGroup(UNGROUPED_KEY, undefined, undefined, undefined, '', orderedUngrouped(stray, ungroupedOrder, list.byId)));
    }
    return groups;
}
/** Keep navigation presentation independent from domain-owned interaction objects. */
function visiblePendingKind(kind) {
    switch (kind) {
        case 'approval':
        case 'plan-review':
        case 'question':
            return kind;
        default:
            return undefined;
    }
}
function sessionNode(s, descendants, pendingInteractions) {
    const pendingInteraction = visiblePendingKind(pendingInteractions.get(s.id)?.kind);
    return {
        id: s.id,
        title: sessionTitle(s),
        blank: s.blank,
        running: s.running,
        runningSubagentCount: descendants.get(s.id)?.runningCount ?? 0,
        completed: s.completed === true,
        hasActiveSchedule: hasActiveSchedule(s),
        updatedAt: s.updatedAt,
        ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
    };
}
/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Every group shows; sessions populate under expanded groups in the selected
 * local order. Blank sessions are excluded except for the selected
 * provisional New Session row; archived sessions are excluded everywhere.
 * Content search lives outside this derivation
 * (see {@link deriveSearchResults}).
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param workspaces - real Workspaces in Host group order with caller-projected Session order.
 * @param archivedSessionIds - registry-global archive set.
 * @param pendingInteractions - pending UI interactions by Session.
 * @param view - local expansion arrays.
 * @returns group sections in render order.
 */
export function deriveGroups(list, workspaces, archivedSessionIds, pendingInteractions, view) {
    const archived = new Set(archivedSessionIds);
    const expandedGroups = new Set(view.expandedGroups);
    const descendants = indexSubagentDescendants(list.byId);
    const currentGroup = list.current === undefined
        ? undefined
        : owningGroupKey(workspaces, list.current);
    const groups = [];
    for (const g of groupByWorkspace(list, workspaces, archived, view.ungroupedOrder)) {
        const expanded = expandedGroups.has(g.key);
        groups.push({
            key: g.key,
            workspaceId: g.workspaceId,
            cwd: g.cwd,
            createdAt: g.createdAt,
            label: g.label,
            sessionCount: g.sessions.length,
            expanded,
            containsCurrent: g.key === currentGroup,
            sessions: expanded
                ? g.sessions.map(session => sessionNode(session, descendants, pendingInteractions))
                : [],
        });
    }
    return groups;
}
/**
 * Select flat-list members without deriving row presentation or ordering.
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @returns known visible Session ids in list order, including ordinary forks and only the current blank.
 */
export function visibleSessionIds(list, archivedSessionIds) {
    const archived = new Set(archivedSessionIds);
    return list.ids.filter((id) => {
        const s = list.byId[id];
        return s !== undefined && sessionVisible(s, list.current, archived);
    });
}
/**
 * Derive flat rows from the browser's ordered visible Session ids.
 * @param list - sessions list snapshot used to select the ids.
 * @param sessionIds - known visible members in render order, including any pinned blank.
 * @param pendingInteractions - pending UI interactions by Session.
 * @returns flat rows in the supplied order with current status indicators.
 */
export function deriveFlat(list, sessionIds, pendingInteractions) {
    const descendants = indexSubagentDescendants(list.byId);
    return sessionIds
        .map(id => sessionNode(list.byId[id], descendants, pendingInteractions));
}
/**
 * Merge immediate title/Workspace substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set (members never match).
 * @param pendingInteractions - pending UI interactions by Session.
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
export function deriveSearchResults(list, workspaces, query, archivedSessionIds, pendingInteractions, content, limit) {
    const q = query.trim().toLowerCase();
    if (q === '')
        return { items: [], hasMore: false };
    const archived = new Set(archivedSessionIds);
    const descendants = indexSubagentDescendants(list.byId);
    const workspaceBySession = new Map();
    for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds) {
            if (!workspaceBySession.has(sessionId))
                workspaceBySession.set(sessionId, workspace.title);
        }
    }
    const labelOf = (summary) => workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd);
    const contentBySession = new Map();
    for (const item of content.items) {
        if (!contentBySession.has(item.sessionId))
            contentBySession.set(item.sessionId, item);
    }
    const local = [];
    for (const id of list.ids) {
        const summary = list.byId[id];
        // Blank placeholders never match a query (their canonical title displays
        // localized, so matching it would tie search to one language).
        if (summary === undefined || summary.blank || !sessionVisible(summary, list.current, archived))
            continue;
        if (sessionTitle(summary).toLowerCase().includes(q)
            || labelOf(summary).toLowerCase().includes(q)) {
            local.push(summary);
        }
    }
    const localById = new Map(local.map(summary => [summary.id, summary]));
    const orderedLocal = orderByRecency(local.map(summary => summary.id), list.byId)
        .map(id => localById.get(id));
    const ordered = [];
    const included = new Set();
    const include = (summary) => {
        if (included.has(summary.id))
            return;
        included.add(summary.id);
        ordered.push(summary);
    };
    for (const summary of orderedLocal)
        include(summary);
    for (const item of content.items) {
        const summary = list.byId[item.sessionId];
        if (summary !== undefined && !summary.blank && sessionVisible(summary, list.current, archived))
            include(summary);
    }
    return {
        items: ordered.slice(0, limit).map((summary) => {
            const match = contentBySession.get(summary.id);
            const pendingInteraction = visiblePendingKind(pendingInteractions.get(summary.id)?.kind);
            return {
                id: summary.id,
                title: sessionTitle(summary),
                workspace: labelOf(summary),
                running: summary.running,
                runningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,
                ...(pendingInteraction === undefined
                    ? {}
                    : { pendingInteraction }),
                completed: summary.completed === true,
                hasActiveSchedule: hasActiveSchedule(summary),
                ...match === undefined ? {} : { snippet: match.snippet },
            };
        }),
        hasMore: content.hasMore || ordered.length > limit,
    };
}
//# sourceMappingURL=tree.js.map