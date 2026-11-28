/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
import { defineStore } from '@deepseek-ai/dsh-client-store';
/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__';
/** Copy read-only projections into the persisted mutable store representation. */
function copySessionOrders(orders) {
    return Object.fromEntries(Object.entries(orders).map(([key, order]) => [key, [...order]]));
}
/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore() {
    return defineStore({
        init: () => ({
            groupBy: 'workspace',
            orderBy: 'updated',
            groupExpansion: {},
            sessionOrderByAccount: {},
        }),
        persist: 'dsh.workspace.view.v5',
        actions: {
            setGroupBy: (d, mode) => { d.groupBy = mode; },
            setOrderBy: (d, mode, initialOrders) => {
                if (mode === d.orderBy)
                    return;
                d.sessionOrderByAccount = mode === 'manual' ? copySessionOrders(initialOrders) : {};
                d.orderBy = mode;
            },
            setGroupExpanded: (d, key, expanded) => { d.groupExpansion[key] = expanded; },
            retainAccountKeys: (d, workspaceKeys) => {
                const retained = new Set(workspaceKeys);
                d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));
                d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)));
                delete d.sessionUpdatedAtByAccount;
            },
            syncSessionOrders: (d, orders) => {
                if (d.orderBy !== 'manual')
                    return;
                Object.assign(d.sessionOrderByAccount, copySessionOrders(orders));
            },
            setSessionOrder: (d, accountKey, order, initialOrders) => {
                if (d.orderBy === 'updated')
                    d.sessionOrderByAccount = copySessionOrders(initialOrders);
                d.orderBy = 'manual';
                d.sessionOrderByAccount[accountKey] = [...order];
            },
        },
    });
}
//# sourceMappingURL=stores.js.map