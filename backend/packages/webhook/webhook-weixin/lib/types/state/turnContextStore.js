import { probe } from '../diagnostics/probe.js';
export class TurnContextStore {
    store;
    constructor(store){
        this.store = store;
    }
    bind(session_id, turn, context) {
        this.store.bind_turn_context({
            session_id,
            turn,
            delivery_id: context.delivery_id,
            user_id: context.user_id,
            ...context.context_token === undefined ? {} : {
                context_token: context.context_token
            }
        });
    }
    get(session_id, turn) {
        return this.store.get_turn_context(session_id, turn);
    }
    bind_if_absent(session_id, turn, context) {
        if (this.get(session_id, turn) !== undefined) {
            probe('turn-context', 'bind.skipped_exists', {
                session_id,
                turn,
                delivery_id: context.delivery_id
            });
            return false;
        }
        this.bind(session_id, turn, context);
        return true;
    }
    resolve(session_id, turn) {
        const exact = this.get(session_id, turn);
        if (exact !== undefined) return exact;
        const fallback = this.store.latest_delivery_for_session(session_id);
        if (fallback === undefined) {
            probe('turn-context', 'resolve.miss', {
                session_id,
                turn
            });
            return undefined;
        }
        probe('turn-context', 'resolve.fallback', {
            session_id,
            turn,
            delivery_id: fallback.delivery_id,
            received_at: fallback.received_at,
            has_context_token: fallback.context_token !== undefined
        });
        return {
            delivery_id: fallback.delivery_id,
            user_id: fallback.user_id,
            ...fallback.context_token === undefined ? {} : {
                context_token: fallback.context_token
            }
        };
    }
    latest(session_id) {
        const fallback = this.store.latest_delivery_for_session(session_id);
        if (fallback === undefined) return undefined;
        return {
            delivery_id: fallback.delivery_id,
            user_id: fallback.user_id,
            ...fallback.context_token === undefined ? {} : {
                context_token: fallback.context_token
            }
        };
    }
    latest_token_if_fresh(session_id, max_age_ms = 10 * 60_000) {
        const fallback = this.store.latest_delivery_for_session(session_id);
        if (fallback?.context_token === undefined) return undefined;
        return Date.now() - fallback.received_at <= max_age_ms ? fallback.context_token : undefined;
    }
    async resolve_async(session_id, turn) {
        const exact = await this.store.get_turn_context(session_id, turn);
        if (exact !== undefined) return exact;
        const fallback = await this.store.latest_delivery_for_session(session_id);
        if (fallback === undefined) {
            probe('turn-context', 'resolve.miss', {
                session_id,
                turn
            });
            return undefined;
        }
        return {
            delivery_id: fallback.delivery_id,
            user_id: fallback.user_id,
            ...fallback.context_token === undefined ? {} : {
                context_token: fallback.context_token
            }
        };
    }
    async latest_token_if_fresh_async(session_id, max_age_ms = 10 * 60_000) {
        const fallback = await this.store.latest_delivery_for_session(session_id);
        if (fallback === undefined || Date.now() - fallback.received_at > max_age_ms) return undefined;
        return fallback.context_token;
    }
    async bind_async(session_id, turn, context) {
        await this.store.bind_turn_context({
            session_id,
            turn,
            delivery_id: context.delivery_id,
            user_id: context.user_id,
            ...context.context_token === undefined ? {} : {
                context_token: context.context_token
            }
        });
    }
    async prune_async(session_id, keep = 20) {
        await this.store.prune_turn_context(session_id, keep);
    }
    prune(session_id, keep = 20) {
        this.store.prune_turn_context(session_id, keep);
    }
}
