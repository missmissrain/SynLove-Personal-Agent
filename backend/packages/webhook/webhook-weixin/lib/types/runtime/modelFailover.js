import { existsSync } from 'node:fs';
import { join } from 'node:path';
export function find_model_config(workspace) {
    const candidates = [
        join(workspace, 'config', 'modelConfig.json'),
        join(workspace, 'modelConfig.json')
    ];
    return candidates.find((path)=>existsSync(path));
}
const DEFAULT_COOLDOWN_MS = 60 * 60_000;
const AUTH_COOLDOWN_MS = 24 * 60 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 3 * 60_000;
const NON_CHAT_PROVIDERS = new Set([
    'gemma-local'
]);
export function classify_llm_failure(message) {
    const text = message.toLowerCase();
    if (/限额|额度|quota|insufficient|欠费|余额不足/.test(text)) {
        return 'quota';
    }
    if (/concurrent|too many requests|overload|temporarily unavailable|请稍后重试|并发|繁忙|(^|[^0-9])429([^0-9]|$)/.test(text)) {
        return 'rate_limit';
    }
    if (/(^|[^0-9])40[13]([^0-9]|$)|unauthorized|forbidden|invalid.?api.?key|api.?key.*(invalid|无效|失效|不正确)|鉴权|认证失败|token.*(invalid|无效|过期)/.test(text)) {
        return 'auth';
    }
    if (/(^|[^0-9])404([^0-9]|$)|model.*not.*found|no such model|does not exist|模型不存在|模型已下线/.test(text)) {
        return 'model_missing';
    }
    return undefined;
}
export function cooldown_ms(reason, config) {
    if (reason === 'rate_limit') return RATE_LIMIT_COOLDOWN_MS;
    return reason === 'quota' ? config.cooldown_ms : AUTH_COOLDOWN_MS;
}
export function parse_failover_config(config) {
    const raw = config.failover ?? {};
    const enabled = raw.enabled !== false;
    const cooldown = Number(raw.cooldownMs);
    const known = (provider, model)=>{
        const entry = (config.providers ?? {})[provider];
        if (entry === undefined) return false;
        return (entry.models ?? []).some((item)=>item.id === model);
    };
    const explicit = (raw.order ?? []).filter((item)=>typeof item?.provider === 'string' && typeof item?.model === 'string' && item.provider !== '' && item.model !== '').map((item)=>({
            provider: String(item.provider),
            model: String(item.model)
        })).filter((item)=>known(item.provider, item.model));
    const derived = [];
    const push = (candidate)=>{
        if (derived.some((item)=>item.provider === candidate.provider && item.model === candidate.model)) return;
        derived.push(candidate);
    };
    const default_model = config.defaultModel;
    if (default_model?.provider !== undefined && default_model?.model !== undefined) {
        push({
            provider: default_model.provider,
            model: default_model.model
        });
    }
    for (const [provider, entry] of Object.entries(config.providers ?? {})){
        if (NON_CHAT_PROVIDERS.has(provider)) continue;
        if (entry.apiKey === undefined || entry.apiKey === '') continue;
        for (const model of entry.models ?? []){
            if (typeof model.id === 'string' && model.id !== '') push({
                provider,
                model: model.id
            });
        }
    }
    const order = explicit.length > 0 ? explicit : derived;
    return {
        enabled,
        order,
        cooldown_ms: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : DEFAULT_COOLDOWN_MS
    };
}
export function next_alive_candidate(order, current, is_dead) {
    const start = current === undefined ? 0 : Math.max(0, order.findIndex((item)=>item.provider === current.provider && item.model === current.model) + 1);
    for(let index = start; index < order.length; index += 1){
        const candidate = order[index];
        if (!is_dead(candidate)) return candidate;
    }
    for(let index = 0; index < start && index < order.length; index += 1){
        const candidate = order[index];
        if (!is_dead(candidate)) return candidate;
    }
    return undefined;
}
export class ModelHealth {
    now;
    dead = new Map();
    constructor(now = ()=>Date.now()){
        this.now = now;
    }
    static key(candidate) {
        return `${candidate.provider}/${candidate.model}`;
    }
    mark_dead(candidate, reason, detail, ms) {
        const entry = {
            until: this.now() + ms,
            reason,
            detail: detail.slice(0, 200),
            at: this.now()
        };
        this.dead.set(ModelHealth.key(candidate), entry);
        return entry;
    }
    mark_alive(candidate) {
        this.dead.delete(ModelHealth.key(candidate));
    }
    is_dead(candidate) {
        const entry = this.dead.get(ModelHealth.key(candidate));
        if (entry === undefined) return false;
        if (entry.until <= this.now()) {
            this.dead.delete(ModelHealth.key(candidate));
            return false;
        }
        return true;
    }
    snapshot() {
        const out = [];
        for (const [key, entry] of this.dead){
            if (entry.until <= this.now()) continue;
            const [provider, ...rest] = key.split('/');
            out.push({
                provider: provider ?? '',
                model: rest.join('/'),
                ...entry
            });
        }
        return out;
    }
}
